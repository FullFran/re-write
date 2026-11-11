import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { evaluate } from '../src/hcs/authority.ts';
import { DECISIONS_FILE, readDecisionRecords, validateDecisionRecord } from '../src/hcs/decision-records.ts';
import { grantPermission, readGrants, revokePermission } from '../src/hcs/grants.ts';
import { REWRITE_PERMISSIONS } from '../src/hcs/ids.ts';
import { tempDir } from './helpers.ts';

const entry = 'example.package';
const [permission, other] = REWRITE_PERMISSIONS;
const stored = (dir: string) => JSON.parse(readFileSync(join(dir, 'grants.json'), 'utf8')).grants;

test('a new grant carries a host identifier, and granting twice keeps the first one', () => {
  const dir = tempDir();
  grantPermission(dir, entry, permission);
  const [grant] = stored(dir);
  assert.deepEqual(Object.keys(grant), ['entry', 'permission', 'id']);
  assert.match(grant.id, /^[0-9a-f-]{36}$/);
  grantPermission(dir, entry, permission);
  assert.deepEqual(stored(dir), [grant]);
  assert.deepEqual(readGrants(dir), [grant]);
  grantPermission(dir, entry, other);
  assert.notEqual(stored(dir)[1].id, grant.id);
});

test('a grants file written before grants had identifiers still reads, allows and revokes', () => {
  const dir = tempDir();
  writeFileSync(join(dir, 'grants.json'), JSON.stringify({ grants: [{ entry, permission }] }));
  assert.deepEqual(readGrants(dir), [{ entry, permission }]);
  assert.deepEqual(evaluate({ entry, permission }, readGrants(dir)), { allow: true });
  revokePermission(dir, entry, permission);
  assert.deepEqual(readGrants(dir), []);
  for (const id of ['', 7, 'a'.repeat(257)]) {
    writeFileSync(join(dir, 'grants.json'), JSON.stringify({ grants: [{ entry, permission, id }] }));
    assert.throws(() => readGrants(dir), /Invalid grants file/);
  }
});

test('removing a grant writes one revoked decision record, and removing nothing writes none (HCS-0005-R010)', () => {
  const dir = tempDir();
  grantPermission(dir, entry, permission);
  grantPermission(dir, entry, other);
  assert.deepEqual(readDecisionRecords(dir), [], 'granting is not a decision on an operation');
  revokePermission(dir, entry, permission);
  const records = readDecisionRecords(dir);
  assert.equal(records.length, 1);
  const { id, time, ...rest } = records[0];
  assert.deepEqual(rest, { entry, permission, outcome: 'revoked', decider: { kind: 'subject', id: 'operator' }, channel: 'cli:package-revoke' });
  assert.deepEqual(validateDecisionRecord(records[0]), []);
  assert.ok(Math.abs(Date.parse(time) - Date.now()) < 60_000 && id.length > 0);
  assert.deepEqual(readGrants(dir).map(grant => grant.permission), [other]);
  revokePermission(dir, entry, permission);
  revokePermission(dir, 'example.absent', other);
  assert.equal(readDecisionRecords(dir).length, 1);
});

test('a revocation that cannot be recorded still removes the grant and reports the failure', () => {
  const dir = tempDir();
  grantPermission(dir, entry, permission);
  mkdirSync(join(dir, DECISIONS_FILE));
  assert.throws(() => revokePermission(dir, entry, permission), /decision record/);
  assert.deepEqual(readGrants(dir), []);
});
