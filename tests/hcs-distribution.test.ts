// HCS-0007 verification through the public interface of src/hcs/distribution.ts. Keys are generated per run; the
// clock, trust anchor, assignment and accepted state are stated by each test, never read from the environment.
import assert from 'node:assert/strict';
import crypto, { generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import { syncBuiltinESMExports } from 'node:module';
import test from 'node:test';
import {
  ENVELOPE_PAYLOAD_TYPE, KEY_SET_PAYLOAD_TYPE, contentDigest, readEnvelope, readKeySet, signingInput, verifyEnvelope, verifyKeySet,
  type TrustAnchor, type VerifiedKeySet,
} from '../src/hcs/distribution.ts';
import type { HcsError } from '../src/hcs/errors.ts';

type Doc = Record<string, unknown>;
interface Signer { keyid: string; privateKey: KeyObject; public: string }

const signer = (keyid: string): Signer => {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  return { keyid, privateKey, public: Buffer.from(publicKey.export({ format: 'jwk' }).x!, 'base64url').toString('base64') };
};
const signed = (payloadType: string, doc: Doc, signers: Signer[]): Doc => ({
  ...doc,
  signatures: signers.map(s => ({ keyid: s.keyid, sig: sign(null, signingInput(payloadType, doc), s.privateKey).toString('base64') })),
});
const text = (doc: Doc) => JSON.stringify(doc, null, 2);

const NOW = new Date('2026-11-06T12:00:00Z');
const root1 = signer('root-1'), root2 = signer('root-2'), online1 = signer('online-1'), online2 = signer('online-2');
const anchorKey = (s: Signer) => ({ keyid: s.keyid, keytype: 'ed25519' as const, public: s.public });
const onlineKey = (s: Signer, notBefore = '2026-01-01T00:00:00Z', notAfter = '2027-01-01T00:00:00Z') => ({ ...anchorKey(s), notBefore, notAfter });
const ANCHOR: TrustAnchor = { keys: [anchorKey(root1)] };
const ASSIGNMENT = { tenant: 't-0001', profile: 'desktop', channel: 'stable' };
const CATALOG = {
  hcsVersion: '0.1', id: 'dev.example.desktop', version: '2026.11.06-1',
  entries: [{ id: 'dev.example.a', version: '1', contentHash: `sha256:${'1'.repeat(64)}`, size: 1, mediaType: 'application/vnd.oci.image.layer.v1.tar+gzip', contributions: [{ kind: 'skill', path: 's' }] }],
};
const keySetDoc = (over: Doc = {}): Doc => ({ hcsVersion: '0.1', version: 3, keys: [onlineKey(online1)], ...over });
const envelopeDoc = (over: Doc = {}): Doc => ({ hcsVersion: '0.1', sequence: 42, expires: '2026-11-13T00:00:00Z', binding: { ...ASSIGNMENT }, catalog: CATALOG, ...over });

const acceptKeySet = (doc: Doc = keySetDoc(), signers = [root1], trustAnchor = ANCHOR, now = NOW): VerifiedKeySet => {
  const result = verifyKeySet(text(signed(KEY_SET_PAYLOAD_TYPE, doc, signers)), { trustAnchor, now });
  assert.ok(result.ok, JSON.stringify(result));
  return result.keySet;
};
const KEY_SET = acceptKeySet();
const check = (doc: Doc, signers = [online1], options: Partial<Parameters<typeof verifyEnvelope>[1]> = {}) =>
  verifyEnvelope(text(signed(ENVELOPE_PAYLOAD_TYPE, doc, signers)), { keySet: KEY_SET, assignment: ASSIGNMENT, now: NOW, ...options });
const refused = (result: { ok: boolean; errors?: HcsError[] }, code: string, requirement: string) => {
  assert.equal(result.ok, false);
  assert.deepEqual(result.errors?.map(e => [e.code, e.requirement]), [[code, requirement]]);
};

test('R003: the signature input is the DSSE PAE of the payload type and the canonical document without signatures', () => {
  const doc = { hcsVersion: '0.1', sequence: 1, b: 'z', a: [1, true, null], signatures: [{ keyid: 'k', sig: 'ignored' }] };
  assert.equal(signingInput(ENVELOPE_PAYLOAD_TYPE, doc).toString('utf8'), 'DSSEv1 41 application/vnd.hcs.catalog-envelope+json 59 {"a":[1,true,null],"b":"z","hcsVersion":"0.1","sequence":1}');
  // Lengths count bytes, not characters.
  assert.equal(signingInput(KEY_SET_PAYLOAD_TYPE, { a: 'é' }).toString('utf8'), 'DSSEv1 32 application/vnd.hcs.key-set+json 10 {"a":"é"}');
  assert.equal(contentDigest(doc), contentDigest({ ...doc, signatures: [] }));
  assert.match(contentDigest(doc), /^sha256:[a-f0-9]{64}$/);
});

test('R003: a signature made for the other payload type does not count', () => {
  refused(verifyEnvelope(text(signed(KEY_SET_PAYLOAD_TYPE, envelopeDoc(), [online1])), { keySet: KEY_SET, assignment: ASSIGNMENT, now: NOW }), 'signature_invalid', 'HCS-0007-R005');
  refused(verifyKeySet(text(signed(ENVELOPE_PAYLOAD_TYPE, keySetDoc(), [root1])), { trustAnchor: ANCHOR, now: NOW }), 'signature_invalid', 'HCS-0007-R011');
});

test('R001: version, then shape, are checked before any signature', () => {
  refused(check(envelopeDoc({ hcsVersion: '0.2', sequence: 0 }), []), 'unsupported_hcs_version', 'HCS-0007-R001');
  for (const over of [{ sequence: 0 }, { sequence: '42' }, { expires: '2026-11-13T00:00:00+01:00' }, { expires: '2026-02-30T00:00:00Z' }, { binding: {} }, { binding: { Tenant: 'x' } }, { binding: { tenant: 1 } }, { catalog: [] }, { tenant: 't-0001' }, { 'x-Bad': 1 }]) {
    refused(check(envelopeDoc(over), []), 'manifest_invalid', 'HCS-0007-R001');
  }
  const { sequence: _, ...missing } = envelopeDoc();
  refused(check(missing, []), 'manifest_invalid', 'HCS-0007-R001');
  refused(verifyEnvelope(text({ ...envelopeDoc(), signatures: [{ keyid: 'online-1', sig: 'AAAA' }] }), { keySet: KEY_SET, assignment: ASSIGNMENT, now: NOW }), 'manifest_invalid', 'HCS-0007-R001');
  refused(verifyEnvelope('[]', { keySet: KEY_SET, assignment: ASSIGNMENT, now: NOW }), 'manifest_invalid', 'HCS-0007-R001');
  assert.equal(readEnvelope(text(envelopeDoc({ 'x-example-note': { any: ['value', 1] } }))).ok, true);
});

test('R004: a number that is not a safe integer is refused as manifest_invalid', () => {
  refused(verifyEnvelope(text(envelopeDoc({ 'x-example-ratio': 0.5 })), { keySet: KEY_SET, assignment: ASSIGNMENT, now: NOW }), 'manifest_invalid', 'HCS-0007-R004');
  const beyond = text(envelopeDoc()).replace('"sequence": 42', '"sequence": 42, "x-example-limit": 9007199254740993');
  refused(verifyEnvelope(beyond, { keySet: KEY_SET, assignment: ASSIGNMENT, now: NOW }), 'manifest_invalid', 'HCS-0007-R004');
  refused(verifyKeySet(text(keySetDoc({ 'x-example-ratio': 1.5 })), { trustAnchor: ANCHOR, now: NOW }), 'manifest_invalid', 'HCS-0007-R004');
  assert.equal(check(envelopeDoc({ 'x-example-limit': 9007199254740991 })).ok, true);
});

test('section 4: a document without a canonical form is refused as manifest_invalid', () => {
  const valid = text(signed(ENVELOPE_PAYLOAD_TYPE, envelopeDoc(), [online1]));
  const options = { keySet: KEY_SET, assignment: ASSIGNMENT, now: NOW };
  assert.equal(verifyEnvelope(valid, options).ok, true);
  // JSON.parse would keep the second sequence and verify the signature made over it.
  refused(verifyEnvelope(valid.replace('"sequence": 42', '"sequence": 7, "sequence": 42'), options), 'manifest_invalid', 'HCS-0007-R003');
  refused(verifyEnvelope(text(envelopeDoc({ 'x-example-note': 'SURROGATE' })).replace('SURROGATE', '\\ud800'), options), 'manifest_invalid', 'HCS-0007-R003');
  refused(verifyEnvelope('{"hcsVersion":"0.1"', options), 'manifest_invalid', 'HCS-0007-R003');
  refused(verifyKeySet(text(keySetDoc()).replace('"version": 3', '"version": 3, "version": 4'), { trustAnchor: ANCHOR, now: NOW }), 'manifest_invalid', 'HCS-0007-R003');
});

test('R002: a key set must match its schema and list each keyid once', () => {
  const verify = (doc: Doc) => verifyKeySet(text(signed(KEY_SET_PAYLOAD_TYPE, doc, [root1])), { trustAnchor: ANCHOR, now: NOW });
  refused(verify(keySetDoc({ keys: [onlineKey(online1), { ...onlineKey(online2), keyid: 'online-1' }] })), 'manifest_invalid', 'HCS-0007-R002');
  for (const over of [{ keys: [] }, { keys: [{ ...onlineKey(online1), keytype: 'rsa' }] }, { keys: [{ ...onlineKey(online1), public: 'AAAA' }] }, { keys: [anchorKey(online1)] }, { threshold: 0 }, { threshold: 256 }, { version: 0 }, { hcsVersion: '0.2' }, { extra: 1 }]) {
    refused(verify(keySetDoc(over)), 'manifest_invalid', 'HCS-0007-R002');
  }
  const read = readKeySet(text(keySetDoc({ threshold: 2, keys: [onlineKey(online1), onlineKey(online2)] })));
  assert.ok(read.ok);
  assert.equal(read.keySet.threshold, 2);
});

test('R005: an envelope needs valid signatures from threshold distinct keys of the accepted key set', () => {
  refused(check(envelopeDoc(), []), 'signature_invalid', 'HCS-0007-R005');
  const { signatures: _, ...unsigned } = signed(ENVELOPE_PAYLOAD_TYPE, envelopeDoc(), []);
  refused(verifyEnvelope(text(unsigned), { keySet: KEY_SET, assignment: ASSIGNMENT, now: NOW }), 'signature_invalid', 'HCS-0007-R005');
  refused(check(envelopeDoc(), [root1]), 'signature_invalid', 'HCS-0007-R005');
  refused(check(envelopeDoc(), [{ ...online2, keyid: 'online-1' }]), 'signature_invalid', 'HCS-0007-R005');
  const tampered = signed(ENVELOPE_PAYLOAD_TYPE, envelopeDoc(), [online1]);
  refused(verifyEnvelope(text({ ...tampered, sequence: 43 }), { keySet: KEY_SET, assignment: ASSIGNMENT, now: NOW }), 'signature_invalid', 'HCS-0007-R005');

  const twoOfTwo = acceptKeySet(keySetDoc({ threshold: 2, keys: [onlineKey(online1), onlineKey(online2)] }));
  assert.equal(check(envelopeDoc(), [online1, online2], { keySet: twoOfTwo }).ok, true);
  refused(check(envelopeDoc(), [online1], { keySet: twoOfTwo }), 'signature_invalid', 'HCS-0007-R005');
  refused(check(envelopeDoc(), [online1, online1], { keySet: twoOfTwo }), 'signature_invalid', 'HCS-0007-R005');
  // Two keyids for one public key are one key.
  const alias = { ...online1, keyid: 'online-1b' };
  const aliased = acceptKeySet(keySetDoc({ threshold: 2, keys: [onlineKey(online1), onlineKey(alias)] }));
  refused(check(envelopeDoc(), [online1, alias], { keySet: aliased }), 'signature_invalid', 'HCS-0007-R005');
});

test('R006: the binding must equal the assignment exactly', () => {
  const { channel: _, ...fewer } = ASSIGNMENT;
  for (const binding of [fewer, { ...ASSIGNMENT, channel: 'beta' }, { ...ASSIGNMENT, region: 'eu' }]) {
    refused(check(envelopeDoc({ binding })), 'permission_denied', 'HCS-0007-R006');
  }
  assert.equal(check(envelopeDoc({ binding: { channel: 'stable', tenant: 't-0001', profile: 'desktop' } })).ok, true);
});

test('R007: an envelope is refused from its expiry instant on', () => {
  refused(check(envelopeDoc({ expires: '2026-11-06T12:00:00Z' })), 'signature_invalid', 'HCS-0007-R007');
  refused(check(envelopeDoc({ expires: '2026-11-01T00:00:00Z' })), 'signature_invalid', 'HCS-0007-R007');
  assert.equal(check(envelopeDoc({ expires: '2026-11-06T12:00:00.001Z' })).ok, true);
  // Sub-millisecond precision still counts: the clock is 1 ns before expiry.
  assert.equal(check(envelopeDoc({ expires: '2026-11-06T12:00:00.000000001Z' })).ok, true);
});

test('R008: a lower sequence, or the same sequence with other content, is a rollback', () => {
  const digest = contentDigest(envelopeDoc());
  refused(check(envelopeDoc(), [online1], { lastAccepted: { sequence: 43, digest } }), 'rollback_rejected', 'HCS-0007-R008');
  refused(check(envelopeDoc({ 'x-example-note': 'changed' }), [online1], { lastAccepted: { sequence: 42, digest } }), 'rollback_rejected', 'HCS-0007-R008');
  const again = check(envelopeDoc(), [online1], { lastAccepted: { sequence: 42, digest } });
  assert.ok(again.ok);
  assert.deepEqual(again.accepted, { sequence: 42, digest });
  assert.equal(check(envelopeDoc({ sequence: 43 }), [online1], { lastAccepted: { sequence: 42, digest } }).ok, true);
});

test('R009: only the first failing check is reported, in the order of section 5.2', () => {
  const duplicated = { ...CATALOG, entries: [CATALOG.entries[0], CATALOG.entries[0]] };
  const everything = envelopeDoc({ binding: { tenant: 'other' }, expires: '2026-01-01T00:00:00Z', sequence: 1, catalog: duplicated });
  const lastAccepted = { sequence: 42, digest: contentDigest(envelopeDoc()) };
  refused(check(everything, [], { lastAccepted }), 'signature_invalid', 'HCS-0007-R005');
  refused(check(everything, [online1], { lastAccepted }), 'permission_denied', 'HCS-0007-R006');
  refused(check({ ...everything, binding: ASSIGNMENT }, [online1], { lastAccepted }), 'signature_invalid', 'HCS-0007-R007');
  refused(check({ ...everything, binding: ASSIGNMENT, expires: '2026-11-13T00:00:00Z' }, [online1], { lastAccepted }), 'rollback_rejected', 'HCS-0007-R008');
  const last = check({ ...everything, binding: ASSIGNMENT, expires: '2026-11-13T00:00:00Z', sequence: 43 }, [online1], { lastAccepted });
  assert.equal(last.ok, false);
  assert.deepEqual(!last.ok && last.errors.map(e => [e.code, e.entry]), [['duplicate_entry', 'dev.example.a']]);
});

test('R010: the catalog is validated as HCS-0001 after every envelope check, and returned with the accepted state', () => {
  const invalid = check(envelopeDoc({ catalog: { ...CATALOG, id: 'Not Dotted' } }));
  assert.equal(invalid.ok, false);
  assert.deepEqual(!invalid.ok && invalid.errors.map(e => [e.code, e.requirement]), [['manifest_invalid', 'HCS-0001-R001']]);
  refused(check(envelopeDoc({ catalog: { ...CATALOG, hcsVersion: '0.2' } })), 'unsupported_hcs_version', 'HCS-0001-R002');
  const accepted = check(envelopeDoc());
  assert.ok(accepted.ok);
  assert.deepEqual(accepted.catalog, CATALOG);
  assert.deepEqual(accepted.accepted, { sequence: 42, digest: contentDigest(envelopeDoc()) });
});

test('R011: a key set needs valid signatures from the trust anchor threshold of distinct root keys', () => {
  const verify = (signers: Signer[], trustAnchor: TrustAnchor = ANCHOR) => verifyKeySet(text(signed(KEY_SET_PAYLOAD_TYPE, keySetDoc(), signers)), { trustAnchor, now: NOW });
  const accepted = verify([root1]);
  assert.ok(accepted.ok);
  assert.deepEqual(accepted.accepted, { version: 3, digest: contentDigest(keySetDoc()) });
  refused(verify([]), 'signature_invalid', 'HCS-0007-R011');
  refused(verify([online1]), 'signature_invalid', 'HCS-0007-R011');
  const twoRoots: TrustAnchor = { keys: [anchorKey(root1), anchorKey(root2)], threshold: 2 };
  refused(verify([root1], twoRoots), 'signature_invalid', 'HCS-0007-R011');
  refused(verify([root1, root1], twoRoots), 'signature_invalid', 'HCS-0007-R011');
  assert.equal(verify([root1, root2], twoRoots).ok, true);
});

test('R012: a lower key set version, or the same version with other content, is a rollback', () => {
  const verify = (doc: Doc, lastAccepted: { version: number; digest: string }) => verifyKeySet(text(signed(KEY_SET_PAYLOAD_TYPE, doc, [root1])), { trustAnchor: ANCHOR, now: NOW, lastAccepted });
  const digest = contentDigest(keySetDoc());
  refused(verify(keySetDoc(), { version: 4, digest }), 'rollback_rejected', 'HCS-0007-R012');
  refused(verify(keySetDoc({ keys: [onlineKey(online2)] }), { version: 3, digest }), 'rollback_rejected', 'HCS-0007-R012');
  assert.equal(verify(keySetDoc(), { version: 3, digest }).ok, true);
  assert.equal(verify(keySetDoc({ version: 4, keys: [onlineKey(online2)] }), { version: 3, digest }).ok, true);
});

test('R013: a key set with no key inside its validity window is refused', () => {
  const verify = (keys: unknown[]) => verifyKeySet(text(signed(KEY_SET_PAYLOAD_TYPE, keySetDoc({ keys }), [root1])), { trustAnchor: ANCHOR, now: NOW });
  refused(verify([onlineKey(online1, '2025-01-01T00:00:00Z', '2026-01-01T00:00:00Z'), onlineKey(online2, '2027-01-01T00:00:00Z', '2028-01-01T00:00:00Z')]), 'signature_invalid', 'HCS-0007-R013');
  assert.equal(verify([onlineKey(online1, '2025-01-01T00:00:00Z', '2026-01-01T00:00:00Z'), onlineKey(online2)]).ok, true);
});

test('R014: a signature counts from notBefore (inclusive) until notAfter (exclusive)', () => {
  const window = acceptKeySet(keySetDoc({ keys: [onlineKey(online1, '2026-11-06T12:00:00Z', '2026-11-06T13:00:00Z'), onlineKey(online2)] }));
  const at = (now: string) => check(envelopeDoc(), [online1], { keySet: window, now: new Date(now) });
  refused(at('2026-11-06T11:59:59.999Z'), 'signature_invalid', 'HCS-0007-R005');
  assert.equal(at('2026-11-06T12:00:00Z').ok, true);
  assert.equal(at('2026-11-06T12:59:59.999Z').ok, true);
  refused(at('2026-11-06T13:00:00Z'), 'signature_invalid', 'HCS-0007-R005');
});

test('an envelope is only verified against a key set that verifyKeySet accepted', () => {
  const read = readKeySet(text(signed(KEY_SET_PAYLOAD_TYPE, keySetDoc(), [online1])));
  assert.ok(read.ok);
  assert.throws(() => verifyEnvelope(text(envelopeDoc()), { keySet: read.keySet as VerifiedKeySet, assignment: ASSIGNMENT, now: NOW }), TypeError);
  assert.throws(() => verifyEnvelope(text(envelopeDoc()), { keySet: structuredClone(KEY_SET), assignment: ASSIGNMENT, now: NOW }), TypeError);
});

test('host inputs that are not what section 3.3 defines are refused instead of trusted', () => {
  const keySet = text(signed(KEY_SET_PAYLOAD_TYPE, keySetDoc(), [root1]));
  for (const trustAnchor of [{ keys: [] }, { keys: [{ ...anchorKey(root1), public: 'AAAA' }] }, { keys: [anchorKey(root1), anchorKey(root1)] }, { keys: [anchorKey(root1)], threshold: 0 }, { keys: [anchorKey(root1)], threshold: 1.5 }]) {
    assert.throws(() => verifyKeySet(keySet, { trustAnchor: trustAnchor as TrustAnchor, now: NOW }), TypeError);
  }
  assert.throws(() => verifyKeySet(keySet, { trustAnchor: ANCHOR, now: new Date(Number.NaN) }), TypeError);
  assert.throws(() => verifyKeySet(keySet, { trustAnchor: ANCHOR, now: NOW, lastAccepted: { version: 3, digest: 'sha256:short' } }), TypeError);
  assert.throws(() => check(envelopeDoc(), [online1], { assignment: {} }), TypeError);
  assert.throws(() => check(envelopeDoc(), [online1], { lastAccepted: { sequence: 0, digest: contentDigest(envelopeDoc()) } }), TypeError);
});

test('R001: an unsupported version is reported before the number rule of R004', () => {
  const options = { keySet: KEY_SET, assignment: ASSIGNMENT, now: NOW };
  refused(verifyEnvelope(text(envelopeDoc({ hcsVersion: '0.2', 'x-example-ratio': 0.5 })), options), 'unsupported_hcs_version', 'HCS-0007-R001');
  refused(verifyEnvelope('{"x-example-big":1e400,"hcsVersion":"9.9"}', options), 'unsupported_hcs_version', 'HCS-0007-R001');
  refused(verifyEnvelope(text(envelopeDoc({ 'x-example-ratio': 0.5 })), options), 'manifest_invalid', 'HCS-0007-R004');
  // A document that cannot be read at all has no version to report.
  refused(verifyEnvelope('{"hcsVersion":"0.2","x-example-ratio":0.5', options), 'manifest_invalid', 'HCS-0007-R003');
  refused(verifyEnvelope('{"hcsVersion":"0.2","hcsVersion":"0.1"}', options), 'manifest_invalid', 'HCS-0007-R003');
  // Key sets: another version is manifest_invalid (R002), also when a number is out of the domain.
  refused(verifyKeySet(text(keySetDoc({ hcsVersion: '0.2', 'x-example-ratio': 0.5 })), { trustAnchor: ANCHOR, now: NOW }), 'manifest_invalid', 'HCS-0007-R002');
});

test('error messages of a refused document carry no text of the document', () => {
  const result = verifyEnvelope('{"hcsVersion":"0.1","secret-name":1,"secret-name":2}', { keySet: KEY_SET, assignment: ASSIGNMENT, now: NOW });
  assert.equal(result.ok, false);
  assert.equal(JSON.stringify(result).includes('secret'), false);
});

test('only the first signature of each keyid is tried', () => {
  const good = signed(ENVELOPE_PAYLOAD_TYPE, envelopeDoc(), [online1]);
  const [valid] = good.signatures as { keyid: string; sig: string }[];
  const invalid = { keyid: 'online-1', sig: Buffer.alloc(64).toString('base64') };
  const options = { keySet: KEY_SET, assignment: ASSIGNMENT, now: NOW };
  assert.equal(verifyEnvelope(text({ ...good, signatures: [valid, invalid, invalid] }), options).ok, true);
  refused(verifyEnvelope(text({ ...good, signatures: [invalid, valid] }), options), 'signature_invalid', 'HCS-0007-R005');
  const keySet = signed(KEY_SET_PAYLOAD_TYPE, keySetDoc(), [root1]);
  const rootInvalid = { keyid: 'root-1', sig: invalid.sig };
  refused(verifyKeySet(text({ ...keySet, signatures: [rootInvalid, ...(keySet.signatures as unknown[])] }), { trustAnchor: ANCHOR, now: NOW }), 'signature_invalid', 'HCS-0007-R011');
});

test('repeated signatures cost one key import and one verification per keyid', t => {
  const calls = { verify: 0, createPublicKey: 0 };
  const original = { verify: crypto.verify, createPublicKey: crypto.createPublicKey };
  t.after(() => { Object.assign(crypto, original); syncBuiltinESMExports(); });
  crypto.verify = ((...args: Parameters<typeof original.verify>) => { calls.verify++; return original.verify(...args); }) as typeof crypto.verify;
  crypto.createPublicKey = ((...args: Parameters<typeof original.createPublicKey>) => { calls.createPublicKey++; return original.createPublicKey(...args); }) as typeof crypto.createPublicKey;
  syncBuiltinESMExports();
  const repeated = (keyid: string) => Array.from({ length: 1000 }, () => ({ keyid, sig: Buffer.alloc(64).toString('base64') }));
  refused(verifyKeySet(text({ ...keySetDoc(), signatures: repeated('root-1') }), { trustAnchor: ANCHOR, now: NOW }), 'signature_invalid', 'HCS-0007-R011');
  assert.deepEqual(calls, { verify: 1, createPublicKey: 1 });
  refused(verifyEnvelope(text({ ...envelopeDoc(), signatures: [...repeated('online-1'), ...repeated('unknown')].slice(500, 1500) }), { keySet: KEY_SET, assignment: ASSIGNMENT, now: NOW }), 'signature_invalid', 'HCS-0007-R005');
  assert.deepEqual(calls, { verify: 2, createPublicKey: 2 });
});

test('local limits: at most 1024 keys and 1024 signatures per document, refused before any verification', () => {
  const zero = Buffer.alloc(64).toString('base64');
  const manySignatures = (count: number) => Array.from({ length: count }, () => ({ keyid: 'r1', sig: zero }));
  const manyKeys = (count: number) => Array.from({ length: count }, (_, i) => ({ ...onlineKey(online1), keyid: `k-${i}` }));
  const started = performance.now();
  refused(verifyKeySet(JSON.stringify({ ...keySetDoc(), signatures: manySignatures(60_000) }), { trustAnchor: ANCHOR, now: NOW }), 'manifest_invalid', 'HCS-0007-R002');
  refused(verifyKeySet(JSON.stringify(keySetDoc({ keys: manyKeys(24_000) })), { trustAnchor: ANCHOR, now: NOW }), 'manifest_invalid', 'HCS-0007-R002');
  refused(verifyEnvelope(JSON.stringify({ ...envelopeDoc(), signatures: manySignatures(60_000) }), { keySet: KEY_SET, assignment: ASSIGNMENT, now: NOW }), 'manifest_invalid', 'HCS-0007-R001');
  // Generous bound: the unbounded version needed about 13 s and 3 s for the first two documents.
  assert.ok(performance.now() - started < 6000, `took ${Math.round(performance.now() - started)} ms`);
  refused(verifyKeySet(JSON.stringify(keySetDoc({ keys: manyKeys(1025) })), { trustAnchor: ANCHOR, now: NOW }), 'manifest_invalid', 'HCS-0007-R002');
  refused(verifyKeySet(JSON.stringify({ ...keySetDoc(), signatures: manySignatures(1025) }), { trustAnchor: ANCHOR, now: NOW }), 'manifest_invalid', 'HCS-0007-R002');
  assert.equal(readKeySet(JSON.stringify({ ...keySetDoc({ keys: manyKeys(1024) }), signatures: manySignatures(1024) })).ok, true);
  refused(readKeySet(JSON.stringify(keySetDoc({ keys: [...manyKeys(1023), { ...onlineKey(online2), keyid: 'k-7' }] }))), 'manifest_invalid', 'HCS-0007-R002');
  assert.throws(() => verifyKeySet(text(keySetDoc()), { trustAnchor: { keys: manyKeys(1025).map(({ keyid }) => ({ ...anchorKey(root1), keyid })) }, now: NOW }), TypeError);
});
