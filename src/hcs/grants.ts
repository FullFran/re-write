import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeSync } from 'node:fs';
import { join, posix } from 'node:path';
import { randomUUID } from 'node:crypto';
import { evaluate, matching, readRequestDocument, type Grant, type PermissionRequest } from './authority.ts';
import type { CatalogEntry } from './catalog.ts';
import { writeDecisionRecord, type Decider } from './decision-records.ts';
import { HcsFailure, hcsError } from './errors.ts';
import { isDottedId, REWRITE_PERMISSIONS } from './ids.ts';
import { fetchPackageBytes, readPackageMembers, verifyPackage } from './package.ts';

// Grants held by the host, one record per entry and permission (HCS-0005). They live in
// `<data-dir>/grants.json` and are read again on every check, so a revocation applies to the next
// dispatched operation without a restart (HCS-0005-R003). A grant carries the host's `id` for it;
// files written before grants had one still read, and those grants are named by `grantId`.
const GRANTS_FILE = 'grants.json';
// The request document at the root of a package (HCS-0005 request document; see docs/hcs.md).
export const REQUEST_DOCUMENT = 'requests.json';
const MAX_REQUEST_DOCUMENT = 65_536;
const MAX_PACKAGE_BYTES = 256 * 1024 * 1024 + 10_000 * 1023 + 1024;

const grantable = (permission: string) => (REWRITE_PERMISSIONS as readonly string[]).includes(permission);

export function readGrants(dataDir: string): Grant[] {
  let text: string;
  try { text = readFileSync(join(dataDir, GRANTS_FILE), 'utf8'); } catch (error: any) { if (error.code === 'ENOENT') return []; throw error; }
  const value: unknown = JSON.parse(text);
  if (!value || typeof value !== 'object' || !('grants' in value) || !Array.isArray(value.grants)) throw new Error('Invalid grants file');
  return value.grants.map((grant: unknown) => {
    if (!grant || typeof grant !== 'object' || !('entry' in grant) || !('permission' in grant)
      || typeof grant.entry !== 'string' || !isDottedId(grant.entry)
      || typeof grant.permission !== 'string' || !grantable(grant.permission)
      || ('id' in grant && (typeof grant.id !== 'string' || grant.id.length < 1 || [...grant.id].length > 256))) {
      throw new Error('Invalid grants file');
    }
    return { entry: grant.entry, permission: grant.permission, ...('id' in grant ? { id: grant.id as string } : {}) };
  });
}

// What a decision record names when this grant decides (HCS-0005 section 3.3).
export const grantId = (grant: Grant): string => grant.id ?? `${grant.entry}:${grant.permission}`;

// Replace the file in one step: write a sibling temp file, fsync, rename.
function writeGrants(dataDir: string, grants: Grant[]): void {
  mkdirSync(dataDir, { recursive: true });
  const path = join(dataDir, GRANTS_FILE);
  const temporary = `${path}.${randomUUID()}.tmp`;
  const fd = openSync(temporary, 'wx', 0o600);
  try { writeSync(fd, `${JSON.stringify({ grants }, null, 2)}\n`); fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(temporary, path);
}

// Administrative: run from the server's shell. Review permissions are never grantable to a package.
export function grantPermission(dataDir: string, entry: string, permission: string): void {
  if (!isDottedId(entry)) throw new Error(`invalid entry id: ${entry}`);
  if (!grantable(permission)) throw new Error(`permission cannot be granted: ${permission}`);
  const grants = readGrants(dataDir);
  if (!grants.some(grant => grant.entry === entry && grant.permission === permission)) grants.push({ entry, permission, id: randomUUID() });
  writeGrants(dataDir, grants);
}

// Administrative, like granting. Each grant removed writes one `revoked` decision record
// (HCS-0005-R010). The shell has no authenticated person, so the decider is the operator role. The
// grant is removed first: if the record cannot be written the revocation still holds, and the error
// is reported.
export function revokePermission(dataDir: string, entry: string, permission: string): void {
  const grants = readGrants(dataDir);
  const kept = grants.filter(grant => grant.entry !== entry || grant.permission !== permission);
  writeGrants(dataDir, kept);
  for (let removed = grants.length - kept.length; removed > 0; removed--) {
    try {
      writeDecisionRecord(dataDir, { entry, permission, outcome: 'revoked', decider: { kind: 'subject', id: 'operator' }, channel: 'cli:package-revoke' });
    } catch (error) {
      throw new Error(`grant removed, but its decision record could not be written: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

// The permissions a verified package requests. No package code runs: the archive is only read. An
// archive that cannot be read is refused like when unpacking it (`integrity_mismatch`).
export function packageRequests(bytes: Uint8Array, entry: CatalogEntry): PermissionRequest[] {
  verifyPackage(bytes, entry);
  const members = readPackageMembers(bytes, MAX_PACKAGE_BYTES)
    .filter(member => posix.normalize(member.name).replace(/\/$/, '') === REQUEST_DOCUMENT);
  if (members.length === 0) return [];
  if (members.length > 1 || members[0].type !== '0') throw new Error('Invalid request document');
  if (members[0].size > MAX_REQUEST_DOCUMENT) throw new Error('Request document is too large');
  let value: unknown;
  try { value = JSON.parse(members[0].data.toString('utf8')); } catch { throw new Error('Request document is not valid JSON'); }
  return readRequestDocument(value, entry.id);
}

// The lifecycle's default authorization: an entry is authorized only when every permission its
// package requests is granted. A package that requests nothing needs no grant. Aborting `signal`
// aborts the package download.
// Each permission decided writes one decision record to `<grantsDir>/decisions.jsonl`, next to the
// `grants.json` that decided, before it is acted on (HCS-0005-R010), with channel
// `lifecycle-authorize`. Its `operation` is one identifier generated when the authorizer is created
// and shared by every entry it authorizes: the lifecycle creates one per apply run. When a record
// cannot be written the entry is not authorized (HCS-0005-R012).
export function grantAuthorizer(options: { grantsDir: string; storeDir: string }): (entry: CatalogEntry, signal?: AbortSignal) => Promise<boolean> {
  const operation = randomUUID();
  return async (entry, signal) => {
    let bytes: Uint8Array;
    try { bytes = await fetchPackageBytes(entry, { storeDir: options.storeDir, signal }); } catch (error) {
      const reason = error instanceof Error && error.message ? error.message : String(error);
      throw new HcsFailure([hcsError('integrity_mismatch', `Package content unavailable: ${reason}`, { entry: entry.id, requirement: 'HCS-0001-R007' })]);
    }
    const requests = packageRequests(bytes, entry);
    const grants = readGrants(options.grantsDir);
    for (const { permission } of requests) {
      const check = { entry: entry.id, permission };
      const decision = evaluate(check, grants);
      const grant = matching(check, grants);
      const decider: Decider = decision.allow && grant ? { kind: 'grant', id: grantId(grant) } : { kind: 'policy', id: 'HCS-0005-R001' };
      try {
        writeDecisionRecord(options.grantsDir, { entry: entry.id, permission, outcome: decision.allow ? 'allow' : 'deny', operation, decider, channel: 'lifecycle-authorize' });
      } catch {
        throw new HcsFailure([hcsError('permission_denied', `Permission denied: ${permission}`, { entry: entry.id, requirement: 'HCS-0005-R012' })]);
      }
      if (!decision.allow) throw new HcsFailure([decision.error]);
    }
    return true;
  };
}
