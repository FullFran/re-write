import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { Library } from '../src/application/library.ts';
import { decide, enforce, ForbiddenError, type DecisionRequest } from '../src/application/decision.ts';
import { HcsFailure } from '../src/hcs/errors.ts';
import { grantPermission, readGrants, revokePermission } from '../src/hcs/grants.ts';
import { REVIEW_DECIDE, REWRITE_PERMISSIONS } from '../src/hcs/ids.ts';
import { cli, tempDir } from './helpers.ts';

const READ = 'com.fullfran.rewrite.book.read';
const PROPOSE = 'com.fullfran.rewrite.claims.propose';
const ENTRY = 'com.example.package';

function setup() {
  const data = tempDir();
  cli('init', join(data, 'books', 'one'));
  cli('init', join(data, 'books', 'two'));
  const library = new Library(data);
  library.grant('one', 'alice');
  library.grant('two', 'bob');
  const base: DecisionRequest = { library, subject: 'alice', book: 'one', door: 'mcp', permission: READ, entry: ENTRY };
  return { data, library, base };
}

test('a package operation without a grant is denied with permission_denied (HCS-0005-R001)', () => {
  const { data, base } = setup();
  const denied = decide(base);
  assert.deepEqual(denied, { allow: false, reason: 'permission-denied', error: {
    code: 'permission_denied', message: `Permission denied: ${READ}`, entry: ENTRY, requirement: 'HCS-0005-R001',
  } });
  assert.throws(() => enforce(base), (error: unknown) => error instanceof HcsFailure && error.errors[0].code === 'permission_denied');
  grantPermission(data, 'com.example.other', READ);
  grantPermission(data, ENTRY, PROPOSE);
  assert.equal(decide(base).allow, false, 'a grant for another entry or permission does not apply');
  grantPermission(data, ENTRY, READ);
  assert.deepEqual(decide(base), { allow: true });
  assert.doesNotThrow(() => enforce(base));
});

test('host built-ins called by a person need only book access, and listing needs no book', () => {
  const { base } = setup();
  assert.deepEqual(decide({ ...base, entry: null }), { allow: true });
  assert.deepEqual(decide({ ...base, entry: null, permission: PROPOSE }), { allow: true });
  assert.deepEqual(decide({ ...base, entry: null, book: null }), { allow: true });
  assert.equal(decide({ ...base, book: null }).allow, false, 'a package still needs its grant to list books');
});

test('cross-book access is denied like a missing book, so existence is not leaked', () => {
  const { data, base } = setup();
  for (const permission of REWRITE_PERMISSIONS) grantPermission(data, ENTRY, permission);
  for (const request of [
    { ...base, book: 'two' }, { ...base, book: 'two', entry: null }, { ...base, book: 'missing' }, { ...base, book: '../one' },
    { ...base, book: 'two', door: 'review' as const, permission: REVIEW_DECIDE, entry: null },
    { ...base, book: 'two', door: 'review' as const, entry: null },
  ]) {
    assert.deepEqual(decide(request), { allow: false, reason: 'unknown-book' });
    assert.throws(() => enforce(request), /^Error: unknown book$/);
  }
});

test('review decisions are reachable only through the review door, whatever is granted', () => {
  const { data, base } = setup();
  for (const permission of REWRITE_PERMISSIONS) grantPermission(data, ENTRY, permission);
  assert.throws(() => grantPermission(data, ENTRY, REVIEW_DECIDE), /cannot be granted/);
  assert.equal(readGrants(data).some(grant => grant.permission === REVIEW_DECIDE), false);
  for (const entry of [ENTRY, null]) {
    const denied = decide({ ...base, permission: REVIEW_DECIDE, entry });
    assert.equal(denied.allow, false);
    assert.equal(!denied.allow && denied.reason, 'forbidden');
    assert.throws(() => enforce({ ...base, permission: REVIEW_DECIDE, entry }), ForbiddenError);
  }
  const review = { ...base, door: 'review' as const, entry: null };
  assert.deepEqual(decide({ ...review, permission: REVIEW_DECIDE }), { allow: true });
  assert.deepEqual(decide({ ...review, permission: READ }), { allow: true });
  assert.equal(decide({ ...review, permission: PROPOSE }).allow, false, 'the review door does not propose');
  assert.equal(decide({ ...review, permission: REVIEW_DECIDE, entry: ENTRY }).allow, false, 'a package never uses the review door');
  assert.equal(decide({ ...base, entry: null, permission: 'com.example.unknown' }).allow, false);
});

test('revoking a package grant or a person\'s book access denies the next call without restart (HCS-0005-R003)', () => {
  const { data, library, base } = setup();
  grantPermission(data, ENTRY, READ);
  assert.equal(decide(base).allow, true);
  assert.equal(decide(base).allow, true, 'a held grant allows every call');
  revokePermission(data, ENTRY, READ);
  assert.equal(decide(base).allow, false);
  grantPermission(data, ENTRY, READ);
  assert.equal(decide(base).allow, true);
  library.revoke('one', 'alice');
  assert.deepEqual(decide(base), { allow: false, reason: 'unknown-book' });
  assert.deepEqual(decide({ ...base, entry: null }), { allow: false, reason: 'unknown-book' });
  assert.deepEqual(library.booksFor('alice'), []);
  assert.deepEqual(library.booksFor('bob'), ['two']);
});

test('the CLI revokes book access and grants or revokes package permissions', () => {
  const { data, library } = setup();
  const revoked = cli('revoke', data, 'one', 'alice');
  assert.equal(revoked.code, 0, revoked.stderr);
  assert.deepEqual(revoked.json, { book: 'one', subject: 'alice' });
  assert.deepEqual(library.booksFor('alice'), []);
  assert.equal(cli('revoke', data, 'one', 'alice').code, 0, 'revoking twice changes nothing');
  assert.equal(cli('revoke', data, 'one').code, 2);
  assert.equal(cli('revoke', data, 'Bad Id', 'alice').code, 1);

  const granted = cli('package-grant', data, ENTRY, READ);
  assert.equal(granted.code, 0, granted.stderr);
  assert.deepEqual(granted.json, { entry: ENTRY, permission: READ });
  assert.deepEqual(JSON.parse(readFileSync(join(data, 'grants.json'), 'utf8')), { grants: [{ entry: ENTRY, permission: READ }] });
  const refused = cli('package-grant', data, ENTRY, REVIEW_DECIDE);
  assert.equal(refused.code, 1);
  assert.match(refused.stderr, /cannot be granted/);
  assert.equal(cli('package-grant', data, ENTRY).code, 2);
  const removed = cli('package-revoke', data, ENTRY, READ);
  assert.equal(removed.code, 0, removed.stderr);
  assert.deepEqual(removed.json, { entry: ENTRY, permission: READ });
  assert.deepEqual(readGrants(data), []);
});
