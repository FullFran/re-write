// The vendored HCS release (vendor/hcs/<version>/) is committed as published and never edited by hand: every file
// must match the release's own SHA256SUMS, and the pin must name the tree that is there.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { contractVersion, parsePin, readPin, releaseDir, releaseUrl, verifyTree } from '../src/hcs/vendor.ts';
import { HCS_VERSION } from '../src/hcs/version.ts';

const root = resolve(import.meta.dirname, '..');
const pin = readPin(root);
const tree = releaseDir(root, pin);

test('the pin names a release of the supported contract, its tarball digest and the release URL', () => {
  assert.equal(contractVersion(pin.version), HCS_VERSION);
  assert.match(pin.sha256, /^[a-f0-9]{64}$/);
  assert.equal(pin.url, `https://github.com/FullFran/hcs/releases/download/v${pin.version}/hcs-${pin.version}.tar.gz`);
});

test('pin validation rejects malformed, incomplete and inconsistent input', () => {
  const valid = { version: '0.1.0-draft.2', sha256: 'a'.repeat(64), url: releaseUrl('0.1.0-draft.2') };
  assert.deepEqual(parsePin(JSON.stringify(valid)), valid);
  for (const value of ['{', '[]', '{}',
    JSON.stringify({ ...valid, version: 'v0.1.0' }),
    JSON.stringify({ ...valid, version: '0.2.0', url: releaseUrl('0.2.0') }),
    JSON.stringify({ ...valid, sha256: 'A'.repeat(64) }),
    JSON.stringify({ ...valid, url: 'https://example.invalid/hcs.tar.gz' })]) {
    assert.throws(() => parsePin(value), value);
  }
});

test('the vendored tree is the pinned release', () => {
  const index = JSON.parse(readFileSync(join(tree, 'index.json'), 'utf8'));
  assert.equal(index.release, pin.version);
  assert.equal(index.indexFormat, 1);
  assert.equal(index.hcsVersion, HCS_VERSION);
});

test('every vendored file matches the release SHA256SUMS', () => {
  assert.ok(verifyTree(tree) > 0);
});

test('only the pinned version is vendored', () => {
  assert.deepEqual(readdirSync(join(root, 'vendor', 'hcs')).sort(), [pin.version, 'PIN.json'].sort());
});

test('a vendored file edited by hand or added fails the integrity check', (t) => {
  const copy = mkdtempSync(join(tmpdir(), 'rewrite-hcs-vendor-'));
  t.after(() => rmSync(copy, { recursive: true, force: true }));
  cpSync(tree, copy, { recursive: true });
  const target = join(copy, 'spec', 'HCS-0001-catalog-manifest.md');
  const bytes = readFileSync(target);
  bytes[bytes.length - 2] ^= 0x01;
  writeFileSync(target, bytes);
  writeFileSync(join(copy, 'extra.txt'), 'not in the release\n');
  assert.throws(() => verifyTree(copy), (error: Error) => {
    assert.match(error.message, /spec\/HCS-0001-catalog-manifest\.md: sha256 differs/);
    assert.match(error.message, /extra\.txt: not listed/);
    return true;
  });
});
