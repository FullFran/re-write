import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readdirSync, readFileSync, renameSync, statSync } from 'node:fs';
import { dirname } from 'node:path';
import { test } from 'node:test';
import { CredentialVault, EngineTokens, isDirectLoopback, parseEngineKey, VaultError } from '../src/adapters/engine-auth.ts';
import { LineDecoder, parseChildMessage, parseCredential } from '../src/adapters/engine-protocol.ts';
import { tempDir } from './helpers.ts';

// Obviously fake values: nothing here was ever issued by a provider.
const FAKE = { access: 'fake-access-token-AAAA', refresh: 'fake-refresh-token-BBBB', expires: 4_102_444_800_000, accountId: 'fake-account-1' };
const key = () => randomBytes(32);

test('the key must be 32 bytes of base64', () => {
  assert.equal(parseEngineKey(randomBytes(32).toString('base64')).length, 32);
  assert.throws(() => parseEngineKey(undefined), /REWRITE_ENGINE_KEY/);
  assert.throws(() => parseEngineKey(randomBytes(16).toString('base64')), /32 bytes/);
});

test('a stored credential is encrypted on disk, private, and comes back unchanged', () => {
  const vault = new CredentialVault(tempDir(), key());
  assert.equal(vault.read('user_fran'), null);
  vault.write('user_fran', FAKE);

  const path = vault.pathFor('user_fran');
  const onDisk = readFileSync(path, 'utf8');
  for (const secret of [FAKE.access, FAKE.refresh, FAKE.accountId, 'user_fran']) {
    assert.ok(!onDisk.includes(secret), 'no secret and no subject in the file or its name');
    assert.ok(!path.includes('user_fran'));
  }
  assert.equal(statSync(path).mode & 0o777, 0o600);
  assert.equal(statSync(dirname(path)).mode & 0o777, 0o700);
  assert.deepEqual(vault.read('user_fran'), FAKE);
  assert.deepEqual(readdirSync(dirname(path)).filter((name) => name.endsWith('.tmp')), [], 'no temporary file is left');
});

test('a credential is unreadable without the key, and the error says nothing about it', () => {
  const data = tempDir();
  new CredentialVault(data, key()).write('user_fran', FAKE);
  const other = new CredentialVault(data, key());
  assert.throws(() => other.read('user_fran'), (error: Error) => {
    assert.ok(error instanceof VaultError);
    assert.ok(!error.message.includes(FAKE.access) && !error.message.includes(FAKE.refresh));
    return true;
  });
});

test("one person's file does not decrypt as another person's", () => {
  const vault = new CredentialVault(tempDir(), key());
  vault.write('user_fran', FAKE);
  assert.equal(vault.read('user_intruso'), null);
  renameSync(vault.pathFor('user_fran'), vault.pathFor('user_intruso'));
  assert.throws(() => vault.read('user_intruso'), VaultError);
});

test('writing replaces the credential and deleting removes it', () => {
  const vault = new CredentialVault(tempDir(), key());
  vault.write('user_fran', FAKE);
  vault.write('user_fran', { ...FAKE, access: 'fake-access-token-ROTATED' });
  assert.equal(vault.read('user_fran')?.access, 'fake-access-token-ROTATED');
  vault.delete('user_fran');
  assert.equal(vault.read('user_fran'), null);
  vault.delete('user_fran');
});

test('an engine token resolves to its person until it is revoked or expires', async () => {
  const tokens = new EngineTokens();
  const token = tokens.mint('user_fran', 60_000);
  assert.match(token, /^rwe_[A-Za-z0-9_-]{43}$/, 'nothing an MCP client could expand as a variable or a command');
  assert.equal(tokens.resolve(token), 'user_fran');
  assert.equal(tokens.resolve(`${token}x`), null);
  assert.equal(tokens.resolve('rwe_'), null);
  assert.equal(tokens.resolve(token.slice(4)), null);
  tokens.revoke(token);
  assert.equal(tokens.resolve(token), null);

  const brief = tokens.mint('user_fran', 5);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(tokens.resolve(brief), null);
});

test('an engine token is only honoured on a direct loopback connection', () => {
  assert.equal(isDirectLoopback('127.0.0.1', {}), true);
  assert.equal(isDirectLoopback('::1', {}), true);
  assert.equal(isDirectLoopback('::ffff:127.0.0.1', {}), true);
  assert.equal(isDirectLoopback('10.0.0.7', {}), false);
  assert.equal(isDirectLoopback(undefined, {}), false);
  for (const header of ['forwarded', 'x-forwarded-for', 'x-real-ip']) {
    assert.equal(isDirectLoopback('127.0.0.1', { [header]: '203.0.113.9' }), false, header);
  }
});

test('messages from the engine process are reduced to known shapes', () => {
  assert.deepEqual(parseChildMessage({ type: 'error', code: 'model_busy', message: 'raw provider body' }), { type: 'error', code: 'model_busy' });
  assert.deepEqual(parseChildMessage({ type: 'error', code: 'HTTP 500: raw provider body' }), { type: 'error', code: 'provider_error' });
  assert.deepEqual(parseChildMessage({ type: 'login.code', userCode: 'ABCD-1234', verificationUri: 'https://evil.example' }), { type: 'login.code', userCode: 'ABCD-1234' });
  assert.equal(parseChildMessage({ type: 'login.code', userCode: '<script>' }), null);
  assert.equal(parseChildMessage({ type: 'login.done', credential: { access: 'a' } }), null);
  assert.equal(parseChildMessage({ type: 'session', tools: ['bash; rm'] }), null);
  assert.equal(parseChildMessage({ type: 'unknown' }), null);
  assert.equal(parseChildMessage('text'), null);
  assert.equal(parseCredential({ ...FAKE, expires: 'soon' }), null);
});

test('the line decoder joins split lines and refuses an endless one', () => {
  const decoder = new LineDecoder();
  assert.deepEqual(decoder.push('{"type":"de'), []);
  assert.deepEqual(decoder.push('lta"}\nnot json\n\n{"a":1}\n'), [{ type: 'delta' }, undefined, { a: 1 }]);
  assert.throws(() => decoder.push('x'.repeat(1_100_000)), /too long/);
});
