import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const cli = resolve('src/cli/main.ts');

function unseal(path: string): void {
  chmodSync(path, 0o700);
  for (const e of readdirSync(path, { withFileTypes: true })) if (e.isDirectory()) unseal(join(path, e.name));
}

test('catalog CLI validates, applies, reports status and keeps the previous generation on a bad digest', () => {
  const temp = mkdtempSync(join(tmpdir(), 'rewrite-catalog-cli-'));
  try {
    const run = (...args: string[]) => spawnSync(process.execPath, [cli, ...args], { cwd: temp, encoding: 'utf8' });
    const packages = [
      { name: 'fixture-annotations', kind: 'x-rewrite-extractor', provides: 'com.fullfran.rewrite.claims.extract@1' },
      { name: 'knowledge-order', kind: 'x-rewrite-check', provides: 'dev.example.knowledge-order.check@1' },
    ].map(p => {
      const built = run('package', resolve('fixtures/packages', p.name), '--out', `${p.name}.tar.gz`, '--json');
      assert.equal(built.status, 0, built.stderr);
      const meta = JSON.parse(built.stdout);
      return {
        id: `com.fullfran.rewrite.${p.name}`, version: '0.1.0', contentHash: meta.contentHash, size: meta.size, mediaType: meta.mediaType,
        locations: [pathToFileURL(join(temp, meta.file)).href],
        contributions: [{ kind: p.kind, path: 'index.mjs', provides: [p.provides] }],
      };
    });
    const write = (file: string, entries: unknown[]) => writeFileSync(join(temp, file), JSON.stringify({ hcsVersion: '0.1', id: 'dev.example.catalog', version: '1', entries }));
    write('catalog.json', packages);
    write('bad.json', [packages[0], { ...packages[1], contentHash: packages[0].contentHash }]);
    writeFileSync(join(temp, 'invalid.json'), '{"hcsVersion":"0.1"}');

    const valid = run('catalog', 'validate', 'catalog.json');
    assert.deepEqual([valid.status, valid.stdout, valid.stderr], [0, 'valid: dev.example.catalog 1 (2 entries)\n', '']);
    const invalid = run('catalog', 'validate', 'invalid.json');
    assert.equal(invalid.status, 1); assert.equal(invalid.stdout, '');
    assert.match(invalid.stderr, /^error: manifest_invalid: /);
    const invalidJson = run('catalog', 'validate', 'invalid.json', '--json');
    assert.equal(invalidJson.status, 1);
    assert.equal(JSON.parse(invalidJson.stderr).code, 'manifest_invalid');

    // The fixture packages request permissions in requests.json; without --grants the state directory holds the grants.
    for (const [entry, permission] of [
      ['com.fullfran.rewrite.fixture-annotations', 'com.fullfran.rewrite.book.read'],
      ['com.fullfran.rewrite.fixture-annotations', 'com.fullfran.rewrite.claims.propose'],
      ['com.fullfran.rewrite.knowledge-order', 'com.fullfran.rewrite.book.read'],
      ['com.fullfran.rewrite.knowledge-order', 'com.fullfran.rewrite.findings.propose'],
    ]) assert.equal(run('package-grant', 'state', entry, permission).status, 0);
    const applied = run('catalog', 'apply', 'catalog.json', '--state', 'state');
    assert.equal(applied.status, 0, applied.stderr);
    assert.equal(applied.stdout, 'generation 1\n  com.fullfran.rewrite.fixture-annotations 0.1.0 active\n  com.fullfran.rewrite.knowledge-order 0.1.0 active\n');
    assert.equal(existsSync(join(temp, 'state/generations/1/entries/com.fullfran.rewrite.knowledge-order/index.mjs')), true);

    const bad = run('catalog', 'apply', 'bad.json', '--state', 'state');
    assert.equal(bad.status, 1); assert.equal(bad.stdout, '');
    assert.match(bad.stderr, /^error: integrity_mismatch: /);

    const status = run('catalog', 'status', '--state', 'state', '--json');
    assert.equal(status.status, 0, status.stderr);
    // R003: the entry returns to its previous state; the failed version is reported by the apply error.
    assert.deepEqual(JSON.parse(status.stdout), { generation: 1, entries: [
      { entry: 'com.fullfran.rewrite.fixture-annotations', version: '0.1.0', state: 'active' },
      { entry: 'com.fullfran.rewrite.knowledge-order', version: '0.1.0', state: 'active' },
    ] });
    const text = run('catalog', 'status', '--state', 'state');
    assert.equal(text.status, 0);
    assert.match(text.stdout, /^generation 1\n {2}com\.fullfran\.rewrite\.fixture-annotations 0\.1\.0 active\n/);

    const empty = run('catalog', 'status', '--state', 'empty');
    assert.deepEqual([empty.status, empty.stdout], [0, 'generation none\n']);
    const usage = run('catalog', 'apply', 'catalog.json');
    assert.equal(usage.status, 2);
    assert.match(usage.stderr, /^usage error: missing --state\n/);
  } finally { unseal(temp); rmSync(temp, { recursive: true, force: true }); }
});
