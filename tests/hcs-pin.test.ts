import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parsePin, targetPath } from '../src/hcs/pin.ts';
import { HCS_VERSION } from '../src/hcs/version.ts';

const commit = '9f40641ebdff9aae73e797b1223b54bcc43a41b7';
const valid = { hcsVersion: '0.1', repository: 'FullFran/hcs', commit };

test('repository pin is valid and matches the supported version', () => {
  assert.deepEqual(parsePin(readFileSync('hcs.pin.json', 'utf8')), valid);
  assert.equal(HCS_VERSION, valid.hcsVersion);
});

test('pin validation rejects malformed, incomplete, and inconsistent input', () => {
  for (const value of ['{', '{}', JSON.stringify({ ...valid, commit: 'A'.repeat(40) }), JSON.stringify({ ...valid, hcsVersion: '0.2' }), JSON.stringify({ ...valid, repository: '' })]) {
    assert.throws(() => parsePin(value));
  }
});

test('target path is scoped to the pinned commit', () => {
  assert.equal(targetPath('/project', valid), `/project/.hcs/${commit}`);
});

function fixture(t: import('node:test').TestContext) {
  const scratch = mkdtempSync(join(tmpdir(), 'rewrite-hcs-test-'));
  t.after(() => rmSync(scratch, { recursive: true, force: true }));
  const root = join(scratch, 'consumer');
  const source = join(scratch, 'source');
  mkdirSync(join(root, 'scripts'), { recursive: true });
  mkdirSync(join(root, 'src', 'hcs'), { recursive: true });
  mkdirSync(source);
  for (const file of ['scripts/hcs-fetch.ts', 'src/hcs/pin.ts', 'src/hcs/fetch.ts', 'src/hcs/version.ts']) {
    cpSync(resolve(file), join(root, file));
  }
  const git = (...args: string[]) => {
    const result = spawnSync('git', ['-C', source, ...args], {
      encoding: 'utf8', env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' },
    });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  git('init', '-q');
  for (const dir of ['schemas', 'requirements', 'conformance']) {
    mkdirSync(join(source, dir));
    writeFileSync(join(source, dir, 'synthetic.txt'), `synthetic ${dir}\n`);
  }
  writeFileSync(join(source, 'not-copied.txt'), 'synthetic extra\n');
  git('add', '.');
  git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'synthetic fixture');
  const revision = git('rev-parse', 'HEAD');
  const pin = (value: string) => writeFileSync(join(root, 'hcs.pin.json'), JSON.stringify({ ...valid, commit: value }));
  const fetch = () => spawnSync(process.execPath, [join(root, 'scripts', 'hcs-fetch.ts')], {
    encoding: 'utf8', env: { ...process.env, HCS_SOURCE_DIR: source },
  });
  return { root, source, revision, pin, fetch };
}

test('fetch copies only pinned artefacts and is idempotent', (t) => {
  const { root, source, revision, pin, fetch } = fixture(t);
  pin(revision);
  const target = join(root, '.hcs', revision);
  const first = fetch();
  assert.equal(first.status, 0, first.stderr);
  assert.equal(first.stdout, `Fetched HCS ${revision} into ${target}\n`);
  assert.equal(first.stderr, '');
  assert.deepEqual(readdirSync(target).sort(), ['.complete', 'conformance', 'requirements', 'schemas']);
  assert.equal(readFileSync(join(target, '.complete'), 'utf8'), `${revision}\n`);
  for (const dir of ['schemas', 'requirements', 'conformance']) {
    assert.equal(readFileSync(join(target, dir, 'synthetic.txt'), 'utf8'), `synthetic ${dir}\n`);
  }
  writeFileSync(join(source, 'schemas', 'synthetic.txt'), 'changed after fetch\n');
  const second = fetch();
  assert.equal(second.status, 0, second.stderr);
  assert.equal(second.stdout, `HCS ${revision} is already fetched\n`);
  assert.equal(second.stderr, '');
  assert.equal(readFileSync(join(target, 'schemas', 'synthetic.txt'), 'utf8'), 'synthetic schemas\n');
});

test('fetch rejects a missing pin without writing artefacts', (t) => {
  const { root, fetch } = fixture(t);
  const result = fetch();
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, 'HCS fetch failed: HCS pin is missing or unreadable: hcs.pin.json\n');
  assert.equal(existsSync(join(root, '.hcs')), false);
});

test('fetch rejects a checkout at a different commit without writing artefacts', (t) => {
  const { root, revision, pin, fetch } = fixture(t);
  const expected = revision === '0'.repeat(40) ? '1'.repeat(40) : '0'.repeat(40);
  pin(expected);
  const result = fetch();
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, `HCS fetch failed: HCS commit mismatch: expected ${expected}, got ${revision}\n`);
  assert.equal(existsSync(join(root, '.hcs')), false);
});


test('fetch refuses a dirty source without creating a target', (t) => {
  const { root, source, revision, pin, fetch } = fixture(t);
  pin(revision);
  writeFileSync(join(source, 'schemas', 'synthetic.txt'), 'dirty\n');
  const result = fetch();
  assert.equal(result.status, 1);
  assert.match(result.stderr, /dirty/i);
  assert.equal(result.stdout, '');
  assert.equal(existsSync(join(root, '.hcs', revision)), false);
});

test('fetch replaces incomplete targets and removes partial copies after failure', (t) => {
  const { root, source, revision, pin, fetch } = fixture(t);
  pin(revision);
  const target = join(root, '.hcs', revision);
  mkdirSync(target, { recursive: true });
  writeFileSync(join(target, 'stale'), 'stale');
  rmSync(join(source, 'schemas'), { recursive: true });
  const failed = fetch();
  assert.equal(failed.status, 1);
  assert.equal(existsSync(target), false);
  assert.deepEqual(readdirSync(join(root, '.hcs')), []);
});

test('injected runner exposes bounded command stderr', async () => {
  const { fetchHcs } = await import('../src/hcs/fetch.ts');
  const root = mkdtempSync(join(tmpdir(), 'rewrite-fetch-runner-'));
  try {
    const stderr = Array.from({ length: 25 }, (_, i) => `line ${i + 1}`).join('\n');
    assert.throws(() => fetchHcs(root, valid, { run: () => { throw Object.assign(new Error('failed'), { stderr }); } }), (error: Error) => {
      assert.match(error.message, /line 25/);
      assert.doesNotMatch(error.message, /line 5(?:\n|$)/);
      return true;
    });
    assert.equal(existsSync(join(root, '.hcs', commit)), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});


test('fetch publishes a fresh replacement and cleans up a failed partial copy', async (t) => {
  const { fetchHcs } = await import('../src/hcs/fetch.ts');
  const { root, source, revision, pin, fetch } = fixture(t);
  pin(revision);
  const target = join(root, '.hcs', revision);
  mkdirSync(target, { recursive: true });
  writeFileSync(join(target, 'stale'), 'stale');
  const result = fetch();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(existsSync(join(target, 'stale')), false);
  assert.equal(readFileSync(join(target, '.complete'), 'utf8'), `${revision}\n`);
  rmSync(target, { recursive: true });
  rmSync(join(source, 'conformance'), { recursive: true });
  assert.throws(() => fetchHcs(root, { ...valid, commit: revision }, { source, run: (_cmd, args) => args.includes('rev-parse') ? revision : '' }));
  assert.equal(existsSync(target), false);
  assert.deepEqual(readdirSync(join(root, '.hcs')), []);
});
