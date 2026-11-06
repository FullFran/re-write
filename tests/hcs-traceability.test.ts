import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { generateTraceability } from '../src/hcs/traceability.ts';

const pin = 'a'.repeat(40);
const requirements = [
  { id: 'HCS-9999-R001', document: 'HCS-9999', keyword: 'MUST', text: 'SYNTHETIC PRIVATE TEXT' },
  { id: 'HCS-9999-R002', document: 'HCS-9999', keyword: 'SHOULD' },
  { id: 'HCS-9998-R001', document: 'HCS-9998', keyword: 'MUST' },
];

test('generates document tables with overrides and never includes text', () => {
  const result = generateTraceability(requirements, {
    documents: { 'HCS-9999': { status: 'planned', issue: 25 }, 'HCS-9998': { status: 'implemented', code: ['src/example.ts'], tests: ['tests/example.test.ts'] } },
    requirements: { 'HCS-9999-R002': { status: 'not-applicable', reason: 'Synthetic reason' } },
  }, pin);
  assert.deepEqual(result.errors, []);
  assert.match(result.markdown, new RegExp(pin));
  assert.match(result.markdown, /generated.*do not edit/i);
  assert.match(result.markdown, /\| HCS-9999-R001 \| MUST \| planned \|.*\[#25\]\(https:\/\/github.com\/FullFran\/re-write\/issues\/25\)/);
  assert.match(result.markdown, /\| HCS-9999-R002 \| SHOULD \| not-applicable \|.*Synthetic reason/);
  assert.match(result.markdown, /src\/example.ts.*tests\/example.test.ts/);
  assert.doesNotMatch(result.markdown, /SYNTHETIC PRIVATE TEXT/);
});

test('rejects missing status, unknown map IDs, missing reasons and issues', () => {
  const result = generateTraceability(requirements, {
    documents: { 'HCS-9999': { status: 'planned' }, 'HCS-9997': { status: 'planned', issue: 1 } },
    requirements: { 'HCS-9999-R002': { status: 'not-applicable', reason: ' ' }, 'HCS-9999-R999': { status: 'planned', issue: 1 } },
  }, pin);
  assert.ok(result.errors.some((e) => e.includes('HCS-9999-R001') && e.includes('issue')));
  assert.ok(result.errors.some((e) => e.includes('HCS-9999-R002') && e.includes('reason')));
  assert.ok(result.errors.some((e) => e.includes('HCS-9998-R001') && e.includes('status')));
  assert.ok(result.errors.some((e) => e.includes('HCS-9999-R999') && e.includes('unknown')));
  assert.ok(result.errors.some((e) => e.includes('HCS-9997') && e.includes('unknown')));
});

test('partial and implemented require code and test paths', () => {
  for (const status of ['partial', 'implemented'] as const) {
    const result = generateTraceability([requirements[0]], { documents: { 'HCS-9999': { status } }, requirements: {} }, pin);
    assert.ok(result.errors.some((e) => e.includes('code') && e.includes('tests')));
  }
});

function cliFixture(t: import('node:test').TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'rewrite-trace-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const file of ['scripts/hcs-traceability.ts', 'src/hcs/traceability.ts', 'src/hcs/pin.ts', 'src/hcs/version.ts']) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    cpSync(resolve(file), join(root, file));
  }
  const put = (path: string, contents: string) => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), contents);
  };
  put('hcs.pin.json', JSON.stringify({ hcsVersion: '0.1', repository: 'synthetic/example', commit: pin }));
  put('docs/conformance/traceability.map.json', JSON.stringify({ documents: { 'HCS-9999': { status: 'planned', issue: 25 } }, requirements: {} }));
  put('docs/conformance/traceability.md', 'original synthetic matrix\n');
  const input = `.hcs/${pin}/requirements/requirements.json`;
  const fetched = () => {
    put(`.hcs/${pin}/.complete`, `${pin}\n`);
    put(input, JSON.stringify({ requirements: [requirements[0]] }));
  };
  const run = (check: boolean) => spawnSync(process.execPath, [join(root, 'scripts/hcs-traceability.ts'), ...(check ? ['--check'] : [])], { cwd: root, encoding: 'utf8' });
  const snapshot = () => {
    const files: Record<string, string> = {};
    const visit = (dir: string, prefix = '') => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const name = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (entry.isDirectory()) visit(join(dir, entry.name), name);
        else files[name] = readFileSync(join(dir, entry.name), 'utf8');
      }
    };
    visit(root);
    return files;
  };
  return { put, input, fetched, run, snapshot };
}

function rejected(result: ReturnType<ReturnType<typeof cliFixture>['run']>, stderr: string) {
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, stderr);
}

test('CLI rejects missing fetch marker or requirements without changing files', (t) => {
  const fixture = cliFixture(t);
  for (const setup of [() => {}, () => fixture.put(`.hcs/${pin}/.complete`, `${pin}\n`)]) {
    setup();
    for (const check of [false, true]) {
      const before = fixture.snapshot();
      rejected(fixture.run(check), 'HCS traceability failed: HCS requirements not fetched; run npm run hcs:fetch\n');
      assert.deepEqual(fixture.snapshot(), before);
    }
  }
});

test('CLI detects drift without changing files and preserves generation and check behavior', (t) => {
  const fixture = cliFixture(t);
  fixture.fetched();
  const generated = fixture.run(false);
  assert.equal(generated.status, 0);
  assert.equal(generated.stdout, 'Generated docs/conformance/traceability.md\n');
  assert.equal(generated.stderr, '');
  const clean = fixture.snapshot();
  assert.doesNotMatch(clean['docs/conformance/traceability.md'], /SYNTHETIC PRIVATE TEXT/);
  const checked = fixture.run(true);
  assert.equal(checked.status, 0);
  assert.equal(checked.stdout, 'Traceability is up to date\n');
  assert.equal(checked.stderr, '');
  assert.deepEqual(fixture.snapshot(), clean);
  fixture.put('docs/conformance/traceability.md', 'synthetic drift\n');
  const before = fixture.snapshot();
  rejected(fixture.run(true), 'HCS traceability failed: Traceability drift: first difference at line 1 (existing 2 lines, generated 10 lines); run npm run hcs:trace\n');
  assert.deepEqual(fixture.snapshot(), before);
});

test('CLI rejects map validation errors in write and check modes without changing files', (t) => {
  const fixture = cliFixture(t);
  fixture.fetched();
  const cases = [
    [{ documents: {}, requirements: {} }, 'HCS-9999-R001: missing or invalid status'],
    [{ documents: { 'HCS-9999': { status: 'planned' } }, requirements: {} }, 'HCS-9999-R001: planned requires an issue'],
    [{ documents: { 'HCS-9999': { status: 'not-applicable', reason: ' ' } }, requirements: {} }, 'HCS-9999-R001: not-applicable requires a reason'],
    [{ documents: { 'HCS-9999': { status: 'planned', issue: 25 } }, requirements: { 'HCS-9999-R999': { status: 'planned', issue: 26 } } }, 'unknown requirement map id: HCS-9999-R999'],
  ] as const;
  for (const [map, error] of cases) {
    fixture.put('docs/conformance/traceability.map.json', JSON.stringify(map));
    for (const check of [false, true]) {
      const before = fixture.snapshot();
      rejected(fixture.run(check), `HCS traceability failed: Traceability validation failed:\n${error}\n`);
      assert.deepEqual(fixture.snapshot(), before);
    }
  }
});
