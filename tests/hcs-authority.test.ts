import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { evaluate } from '../src/hcs/authority.ts';
import { grantPermission, readGrants, revokePermission } from '../src/hcs/grants.ts';
import { REWRITE_PERMISSIONS, REVIEW_DECIDE } from '../src/hcs/ids.ts';

const entry = 'example.package';
const permission = REWRITE_PERMISSIONS[0];
const check = { entry, permission };

test('authority requires the exact entry and permission (R001)', () => {
  for (const grants of [[], [{ entry: 'other.package', permission }], [{ entry, permission: REWRITE_PERMISSIONS[1] }]]) {
    const result = evaluate(check, grants);
    assert.equal(result.allow, false);
    if (!result.allow) assert.deepEqual(result.error, { code: 'permission_denied', message: `Permission denied: ${permission}`, entry, requirement: 'HCS-0005-R001' });
  }
  assert.deepEqual(evaluate(check, [{ entry, permission }]), { allow: true });
});

test('requests, allowed-tools, and extension members do not grant authority (R002, R004)', () => {
  const request = { permission, 'x-autogrant': true, 'allowed-tools': [permission] };
  const input = { requests: [request], 'allowed-tools': [permission], 'x-autogrant': [check], grants: [] };
  assert.equal(evaluate(check, input.grants).allow, false);
  assert.equal(evaluate(check, [{ entry: 'other.package', permission, 'x-autogrant': true }]).allow, false);
});

test('persistent grants are read fresh and revocation affects the next check (R003)', t => {
  const dir = mkdtempSync(join(tmpdir(), 'rewrite-authority-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  assert.deepEqual(readGrants(dir), []);
  assert.equal(evaluate(check, readGrants(dir)).allow, false);
  grantPermission(dir, entry, permission);
  grantPermission(dir, entry, permission);
  assert.deepEqual(JSON.parse(readFileSync(join(dir, 'grants.json'), 'utf8')), { grants: [check] });
  assert.equal(evaluate(check, readGrants(dir)).allow, true);
  revokePermission(dir, entry, permission);
  assert.deepEqual(readGrants(dir), []);
  assert.deepEqual(JSON.parse(readFileSync(join(dir, 'grants.json'), 'utf8')), { grants: [] });
  assert.equal(evaluate(check, readGrants(dir)).allow, false);
});

test('review and unknown permissions cannot be granted', t => {
  const dir = mkdtempSync(join(tmpdir(), 'rewrite-authority-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  grantPermission(dir, entry, permission);
  for (const forbidden of [REVIEW_DECIDE, 'example.unknown']) {
    assert.throws(() => grantPermission(dir, entry, forbidden));
    assert.deepEqual(readGrants(dir), [check]);
    assert.deepEqual(JSON.parse(readFileSync(join(dir, 'grants.json'), 'utf8')), { grants: [check] });
  }
});
