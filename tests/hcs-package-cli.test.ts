import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, symlinkSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { buildPackage } from '../src/hcs/package.ts';

const cli = resolve('src/cli/main.ts');
const fixtures = ['fixture-annotations', 'knowledge-order'];
const mediaType = 'application/vnd.oci.image.layer.v1.tar+gzip';

test('package CLI builds default and explicit outputs, with text and JSON metadata', () => {
  const temp = mkdtempSync(join(tmpdir(), 'rewrite-cli-'));
  try {
    const source = resolve('fixtures/packages/fixture-annotations');
    const run = (...args: string[]) => spawnSync(process.execPath, [cli, ...args], { cwd: temp, encoding: 'utf8' });
    const text = run('package', source);
    assert.equal(text.status, 0, text.stderr);
    assert.equal(text.stderr, '');
    const bytes = readFileSync(join(temp, 'fixture-annotations.tar.gz'));
    const hash = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
    assert.equal(text.stdout, `${hash} ${bytes.length}\n`);
    const json = run('package', source, '--out', 'custom.tar.gz', '--json');
    assert.equal(json.status, 0, json.stderr);
    assert.equal(json.stderr, '');
    assert.deepEqual(JSON.parse(json.stdout), { contentHash: hash, size: bytes.length, mediaType, file: 'custom.tar.gz' });
    assert.deepEqual(readFileSync(join(temp, 'custom.tar.gz')), bytes);
  } finally { rmSync(temp, { recursive: true, force: true }); }
});

test('package CLI refuses symlinks and reports usage errors without output files', () => {
  const temp = mkdtempSync(join(tmpdir(), 'rewrite-cli-'));
  try {
    const source = join(temp, 'source'); mkdirSync(source); symlinkSync('missing', join(source, 'link'));
    const run = (...args: string[]) => spawnSync(process.execPath, [cli, ...args], { cwd: temp, encoding: 'utf8' });
    const refusal = run('package', source, '--out', 'refused.tar.gz');
    assert.equal(refusal.status, 1); assert.equal(refusal.stdout, '');
    assert.match(refusal.stderr, /^error: Unsupported source member: link\n$/);
    assert.throws(() => readFileSync(join(temp, 'refused.tar.gz')), { code: 'ENOENT' });
    const usage = run('package');
    assert.equal(usage.status, 2); assert.equal(usage.stdout, '');
    assert.match(usage.stderr, /^usage error: missing <dir>\n/);
  } finally { rmSync(temp, { recursive: true, force: true }); }
});

test('first two package fixtures build deterministically and expose their contribution functions', async () => {
  for (const fixture of fixtures) {
    const dir = resolve('fixtures/packages', fixture);
    const first = buildPackage(dir), second = buildPackage(dir);
    assert.deepEqual(first.bytes, second.bytes);
    assert.match(first.contentHash, /^sha256:[a-f0-9]{64}$/);
    assert.equal(first.contentHash, second.contentHash);
    assert.equal(first.size, first.bytes.length);
    const contribution = await import(`../fixtures/packages/${fixture}/index.mjs`);
    assert.deepEqual(contribution.default(fixture === 'fixture-annotations' ? { source_file: 'scene.md', text: '' } : []), []);
  }
});

test('existing CLI usage errors remain unchanged', () => {
  const result = spawnSync(process.execPath, [cli, 'unknown'], { encoding: 'utf8' });
  assert.equal(result.status, 2); assert.equal(result.stdout, '');
  assert.match(result.stderr, /^usage error: unknown command: unknown\n/);
});
