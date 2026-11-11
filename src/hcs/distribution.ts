// HCS-0007 (DISTRO-1) verification: a root-signed key set, then a signed catalog envelope, in the order of section
// 5.2. Pure functions: the trust anchor, assignment, accepted state and clock are host inputs (section 3.3) passed
// by the caller; nothing here reads a file, the environment or the system clock, and nothing is persisted (R015).
import { createHash, createPublicKey, verify, type KeyObject } from 'node:crypto';
import { CanonicalError, canonicalize, parseStrictJson } from './canonical-json.ts';
import { DEFAULT_LIMITS, readCatalog, type CatalogManifest } from './catalog.ts';
import { hcsError, type HcsError, type HcsErrorCode } from './errors.ts';
import { isExtensionName } from './ids.ts';
import { HCS_VERSION } from './version.ts';

export const ENVELOPE_PAYLOAD_TYPE = 'application/vnd.hcs.catalog-envelope+json';
export const KEY_SET_PAYLOAD_TYPE = 'application/vnd.hcs.key-set+json';

export interface Signature { keyid: string; sig: string }
export interface PublicKey { keyid: string; keytype: 'ed25519'; public: string }
export interface OnlineKey extends PublicKey { notBefore: string; notAfter: string; [extension: string]: unknown }
/** Root public keys and their threshold (default 1), received at enrollment. Root keys sign key sets only. */
export interface TrustAnchor { keys: PublicKey[]; threshold?: number }
export interface KeySet { hcsVersion: string; version: number; threshold?: number; keys: OnlineKey[]; signatures?: Signature[]; [extension: string]: unknown }
export interface Envelope { hcsVersion: string; sequence: number; expires: string; binding: Record<string, string>; catalog: Record<string, unknown>; signatures?: Signature[]; [extension: string]: unknown }
/** What a host remembers of the last accepted key set: its version and content digest. */
export interface AcceptedKeySet { version: number; digest: string }
/** What a host remembers of the last accepted envelope: its sequence and content digest. */
export interface AcceptedEnvelope { sequence: number; digest: string }

declare const verifiedBrand: unique symbol;
/** A key set that `verifyKeySet` accepted. It is frozen, and only such a key set can verify envelopes. */
export type VerifiedKeySet = Readonly<KeySet> & { readonly [verifiedBrand]: true };

type Obj = Record<string, unknown>;
type Failure = { ok: false; errors: HcsError[] };
const object = (v: unknown): v is Obj => v !== null && typeof v === 'object' && !Array.isArray(v);
const text = (v: unknown): v is string => typeof v === 'string';
const whole = (pattern: RegExp) => (v: unknown): v is string => text(v) && pattern.test(v) && !v.endsWith('\n');
const integer = (min: number, max: number) => (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= min && v <= max;
const isKeyid = whole(/^[A-Za-z0-9._:-]{1,128}$/);
const isPublic = whole(/^[A-Za-z0-9+/]{43}=$/);
const isSig = whole(/^[A-Za-z0-9+/]{86}==$/);
const isDigest = whole(/^sha256:[a-f0-9]{64}$/);
const isBindingName = whole(/^[a-z][a-z0-9-]{0,63}$/);
const isCounter = integer(1, Number.MAX_SAFE_INTEGER);
const isThreshold = integer(1, 255);
const TIMESTAMP = /^([0-9]{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12][0-9]|3[01])T(?:[01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9])(?:\.([0-9]{1,9}))?Z$/;

/** Nanoseconds since the epoch of an RFC 3339 UTC timestamp, or undefined when it is not one (or not a real date). */
function instant(value: unknown): bigint | undefined {
  const match = text(value) && !value.endsWith('\n') ? TIMESTAMP.exec(value) : null;
  if (!match) return undefined;
  const ms = Date.parse(`${match[1]}Z`);
  if (Number.isNaN(ms) || new Date(ms).toISOString().slice(0, 19) !== match[1]) return undefined;
  return BigInt(ms) * 1_000_000n + BigInt((match[2] ?? '').padEnd(9, '0'));
}
const isTimestamp = (v: unknown) => instant(v) !== undefined;
function clock(now: Date): bigint {
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) throw new TypeError('now must be a valid Date');
  return BigInt(now.getTime()) * 1_000_000n;
}

const withoutSignatures = (document: unknown): Obj => {
  if (!object(document)) throw new CanonicalError('A signed document must be a JSON object');
  const { signatures: _, ...rest } = document;
  return rest;
};

/** RFC 8785 bytes of a document without its `signatures` member (HCS-0007 section 4). */
export function unsignedBytes(document: unknown): Buffer {
  return Buffer.from(canonicalize(withoutSignatures(document)), 'utf8');
}

/** DSSE v1 pre-authentication encoding of `payloadType` and the canonical document without signatures (R003). */
export function signingInput(payloadType: string, document: unknown): Buffer {
  const body = unsignedBytes(document);
  return Buffer.concat([Buffer.from(`DSSEv1 ${Buffer.byteLength(payloadType, 'utf8')} ${payloadType} ${body.length} `, 'utf8'), body]);
}

/** `sha256:<hex>` of the canonical document without signatures: two documents with the same digest have the same content. */
export function contentDigest(document: unknown): string {
  return `sha256:${createHash('sha256').update(unsignedBytes(document)).digest('hex')}`;
}

const fail = (code: HcsErrorCode, message: string, requirement: string, pointer?: string): Failure => ({
  ok: false,
  errors: [hcsError(code, message, pointer === undefined ? { requirement } : { requirement, details: { 'x-rewrite-pointer': pointer } })],
});

// The first shape violation of an object, as a JSON pointer, or undefined. `members` maps each allowed name to its
// check; extension members (`x-...`) are allowed when `extensible`, their values being already in the canonical domain.
type Shape = Record<string, (value: unknown, pointer: string) => string | undefined>;
const leaf = (check: (v: unknown) => boolean) => (v: unknown, pointer: string) => (check(v) ? undefined : pointer);
function shape(value: unknown, pointer: string, members: Shape, required: string[], extensible: boolean): string | undefined {
  if (!object(value)) return pointer;
  for (const name of required) if (!Object.hasOwn(value, name)) return `${pointer}/${name}`;
  for (const [name, member] of Object.entries(value)) {
    const at = `${pointer}/${name.replace(/~/g, '~0').replace(/\//g, '~1')}`;
    if (Object.hasOwn(members, name)) { const bad = members[name](member, at); if (bad !== undefined) return bad; }
    else if (!extensible || !isExtensionName(name)) return at;
  }
  return undefined;
}
const list = (item: (v: unknown, pointer: string) => string | undefined, min = 0) => (value: unknown, pointer: string) => {
  if (!Array.isArray(value) || value.length < min) return pointer;
  for (let i = 0; i < value.length; i++) { const bad = item(value[i], `${pointer}/${i}`); if (bad !== undefined) return bad; }
  return undefined;
};
const keyMembers: Shape = { keyid: leaf(isKeyid), keytype: leaf(v => v === 'ed25519'), public: leaf(isPublic) };
const signatures = list((v, p) => shape(v, p, { keyid: leaf(isKeyid), sig: leaf(isSig) }, ['keyid', 'sig'], false));
const onlineKey = (v: unknown, p: string) => shape(v, p, { ...keyMembers, notBefore: leaf(isTimestamp), notAfter: leaf(isTimestamp) }, ['keyid', 'keytype', 'public', 'notBefore', 'notAfter'], true);
const binding = (value: unknown, pointer: string) => {
  if (!object(value) || Object.keys(value).length === 0) return pointer;
  for (const [name, member] of Object.entries(value)) if (!isBindingName(name) || !text(member) || member.length < 1 || [...member].length > 256) return `${pointer}/${name}`;
  return undefined;
};
const envelopeMembers: Shape = { hcsVersion: leaf(v => v === HCS_VERSION), sequence: leaf(isCounter), expires: leaf(isTimestamp), binding, catalog: leaf(object), signatures };
const keySetMembers: Shape = { hcsVersion: leaf(v => v === HCS_VERSION), version: leaf(isCounter), threshold: leaf(isThreshold), keys: list(onlineKey, 1), signatures };

// An envelope wraps a catalog, which has its own limit (HCS-0001-R015), plus signatures and whitespace.
const MAX_DOCUMENT_BYTES = 2 * DEFAULT_LIMITS.maxBytes;

// Strict parse shared by both documents: text without a canonical form is `manifest_invalid` (section 4, R004).
function parse(input: string | Uint8Array): { ok: true; value: unknown } | Failure {
  const size = typeof input === 'string' ? Buffer.byteLength(input) : input.byteLength;
  if (size > MAX_DOCUMENT_BYTES) return fail('manifest_invalid', 'Document exceeds the size limit', 'HCS-0007-R003');
  try { return { ok: true, value: parseStrictJson(input, DEFAULT_LIMITS.maxDepth) }; }
  catch (error) {
    if (!(error instanceof CanonicalError)) throw error;
    return fail('manifest_invalid', `Document has no canonical form: ${error.message}`, error.outOfDomainNumber ? 'HCS-0007-R004' : 'HCS-0007-R003');
  }
}

/** Reads an envelope and checks its version, then its shape (R001, R004). Verifies no signature. */
export function readEnvelope(input: string | Uint8Array): { ok: true; envelope: Envelope } | Failure {
  const parsed = parse(input);
  if (!parsed.ok) return parsed;
  const doc = parsed.value;
  if (!object(doc)) return fail('manifest_invalid', 'Envelope must be an object', 'HCS-0007-R001', '');
  if (doc.hcsVersion !== HCS_VERSION) return fail('unsupported_hcs_version', 'Unsupported HCS version', 'HCS-0007-R001', '/hcsVersion');
  const bad = shape(doc, '', envelopeMembers, ['hcsVersion', 'sequence', 'expires', 'binding', 'catalog'], true);
  if (bad !== undefined) return fail('manifest_invalid', 'Invalid envelope member', 'HCS-0007-R001', bad);
  return { ok: true, envelope: doc as unknown as Envelope };
}

/** Reads a key set and checks its shape and that no `keyid` repeats (R002, R004). Verifies no signature. */
export function readKeySet(input: string | Uint8Array): { ok: true; keySet: KeySet } | Failure {
  const parsed = parse(input);
  if (!parsed.ok) return parsed;
  const doc = parsed.value;
  const bad = shape(doc, '', keySetMembers, ['hcsVersion', 'version', 'keys'], true);
  if (bad !== undefined) return fail('manifest_invalid', 'Invalid key set member', 'HCS-0007-R002', bad);
  const keySet = doc as unknown as KeySet;
  const repeated = keySet.keys.findIndex((key, i) => keySet.keys.findIndex(other => other.keyid === key.keyid) !== i);
  if (repeated !== -1) return fail('manifest_invalid', 'Key set lists a keyid twice', 'HCS-0007-R002', `/keys/${repeated}/keyid`);
  return { ok: true, keySet };
}

const ed25519Key = (key: PublicKey): KeyObject =>
  createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: Buffer.from(key.public, 'base64').toString('base64url') }, format: 'jwk' });

// How many distinct public keys among `keys` have a valid signature over the signing input. A keyid selects a key
// and proves nothing: unknown keyids are ignored, and two keyids for the same public key count once.
function countSigners(payloadType: string, document: { signatures?: Signature[] }, keys: readonly PublicKey[]): number {
  const input = signingInput(payloadType, document);
  const signers = new Set<string>();
  for (const signature of document.signatures ?? []) {
    const key = keys.find(candidate => candidate.keyid === signature.keyid);
    if (key === undefined) continue;
    const identity = Buffer.from(key.public, 'base64').toString('hex');
    if (signers.has(identity)) continue;
    let valid = false;
    try { valid = verify(null, input, ed25519Key(key), Buffer.from(signature.sig, 'base64')); } catch { /* an unusable key verifies nothing */ }
    if (valid) signers.add(identity);
  }
  return signers.size;
}

// R014: equal to or later than notBefore, and earlier than notAfter.
const inWindow = (key: OnlineKey, now: bigint) => now >= instant(key.notBefore)! && now < instant(key.notAfter)!;

function assertTrustAnchor(anchor: TrustAnchor): void {
  const bad = shape(anchor, '', { keys: list((v, p) => shape(v, p, keyMembers, ['keyid', 'keytype', 'public'], false), 1), threshold: leaf(isThreshold) }, ['keys'], false);
  if (bad !== undefined) throw new TypeError(`Invalid trust anchor at ${bad || '/'}`);
  if (new Set(anchor.keys.map(key => key.keyid)).size !== anchor.keys.length) throw new TypeError('Trust anchor lists a keyid twice');
}
function assertAccepted(state: unknown, counter: 'sequence' | 'version'): void {
  if (state === undefined) return;
  if (shape(state, '', { [counter]: leaf(isCounter), digest: leaf(isDigest) }, [counter, 'digest'], false) !== undefined) throw new TypeError(`Invalid accepted state: expected { ${counter}, digest }`);
}

const verifiedKeySets = new WeakSet<object>();
const deepFreeze = <T>(value: T): T => {
  if (value !== null && typeof value === 'object') { for (const member of Object.values(value)) deepFreeze(member); Object.freeze(value); }
  return value;
};

/**
 * Verifies a key set against the trust anchor: shape (R002), root signatures (R011), rollback (R012), and at least
 * one key inside its validity window (R013). Reports the first failing check. On success the caller records
 * `accepted` as the new accepted state. Throws `TypeError` when a host input is not what section 3.3 defines.
 */
export function verifyKeySet(
  input: string | Uint8Array,
  options: { trustAnchor: TrustAnchor; lastAccepted?: AcceptedKeySet; now: Date },
): { ok: true; keySet: VerifiedKeySet; accepted: AcceptedKeySet } | Failure {
  const now = clock(options.now);
  assertTrustAnchor(options.trustAnchor);
  assertAccepted(options.lastAccepted, 'version');
  const read = readKeySet(input);
  if (!read.ok) return read;
  const { keySet } = read;
  if (countSigners(KEY_SET_PAYLOAD_TYPE, keySet, options.trustAnchor.keys) < (options.trustAnchor.threshold ?? 1)) {
    return fail('signature_invalid', 'Key set is not signed by the trust anchor threshold of root keys', 'HCS-0007-R011');
  }
  const accepted = { version: keySet.version, digest: contentDigest(keySet) };
  const last = options.lastAccepted;
  if (last !== undefined && (accepted.version < last.version || (accepted.version === last.version && accepted.digest !== last.digest))) {
    return fail('rollback_rejected', 'Key set version is not newer than the last accepted one', 'HCS-0007-R012');
  }
  if (!keySet.keys.some(key => inWindow(key, now))) return fail('signature_invalid', 'No key of the key set is within its validity window', 'HCS-0007-R013');
  verifiedKeySets.add(deepFreeze(keySet));
  return { ok: true, keySet: keySet as VerifiedKeySet, accepted };
}

/**
 * Verifies an envelope in the order of section 5.2 and reports only the first check that fails (R009): version and
 * shape (R001), signatures (R005, R014), binding (R006), expiry (R007), sequence (R008), then the catalog as HCS-0001
 * (R010). On success the caller records `accepted` as the new accepted state, and only then (R015).
 * `keySet` must come from `verifyKeySet`; anything else is a `TypeError`, as is an invalid host input.
 */
export function verifyEnvelope(
  input: string | Uint8Array,
  options: { keySet: VerifiedKeySet; assignment: Record<string, string>; lastAccepted?: AcceptedEnvelope; now: Date },
): { ok: true; catalog: CatalogManifest; accepted: AcceptedEnvelope } | Failure {
  const now = clock(options.now);
  const { keySet, assignment } = options;
  if (!verifiedKeySets.has(keySet)) throw new TypeError('keySet must be a key set accepted by verifyKeySet');
  if (binding(assignment, '') !== undefined) throw new TypeError('assignment must be an object of strings with at least one member');
  assertAccepted(options.lastAccepted, 'sequence');

  const read = readEnvelope(input);
  if (!read.ok) return read;
  const { envelope } = read;

  if (countSigners(ENVELOPE_PAYLOAD_TYPE, envelope, keySet.keys.filter(key => inWindow(key, now))) < (keySet.threshold ?? 1)) {
    return fail('signature_invalid', 'Envelope is not signed by the threshold of valid keys of the accepted key set', 'HCS-0007-R005');
  }

  const names = Object.keys(envelope.binding);
  if (names.length !== Object.keys(assignment).length || !names.every(name => Object.hasOwn(assignment, name) && assignment[name] === envelope.binding[name])) {
    return fail('permission_denied', 'Envelope is addressed to another assignment', 'HCS-0007-R006');
  }

  if (now >= instant(envelope.expires)!) return fail('signature_invalid', 'Envelope has expired', 'HCS-0007-R007');

  const accepted = { sequence: envelope.sequence, digest: contentDigest(envelope) };
  const last = options.lastAccepted;
  if (last !== undefined && (accepted.sequence < last.sequence || (accepted.sequence === last.sequence && accepted.digest !== last.digest))) {
    return fail('rollback_rejected', 'Envelope sequence is not newer than the last accepted one', 'HCS-0007-R008');
  }

  const catalog = readCatalog(canonicalize(envelope.catalog));
  if (!catalog.ok) return catalog;
  return { ok: true, catalog: catalog.catalog, accepted };
}
