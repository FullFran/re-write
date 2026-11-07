import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildPackage } from '../src/hcs/package.ts';
import { HcsFailure } from '../src/hcs/errors.ts';
import { REWRITE_HOST } from '../src/hcs/host.ts';
import { dispatch } from '../src/hcs/capabilities.ts';
import { applyDesiredSet } from '../src/hcs/host-state.ts';
import { CapabilityRegistry, generationCapabilities, loadRegistry } from '../src/hcs/registry.ts';

const builtin = REWRITE_HOST.builtins[0];
const unsupported = (requirement: string, capability: string) => (e: unknown) => {
  assert.ok(e instanceof HcsFailure);
  assert.deepEqual([e.errors[0].code, e.errors[0].capability, e.errors[0].requirement], ['unsupported_capability', capability, requirement]);
  return true;
};

test('dispatch returns the provider of an active capability and refuses entries that are not active', () => {
  const registry = new CapabilityRegistry({ generation: 3, entries: [
    { entry: 'dev.test.a', state: 'active', provides: ['dev.test.a.cap@1'] },
    { entry: 'dev.test.b', state: 'draining', provides: ['dev.test.b.cap@1'] },
    { entry: 'dev.test.c', state: 'failed', provides: ['dev.test.c.cap@1'] },
    { entry: 'dev.test.d', state: 'prepared', provides: ['dev.test.d.cap@1'] },
  ] });
  assert.equal(registry.dispatch('dev.test.a.cap@1'), 'dev.test.a');
  assert.equal(registry.dispatch(builtin), REWRITE_HOST.id);
  assert.throws(() => registry.dispatch('dev.test.a.cap@2'), unsupported('HCS-0004-R005', 'dev.test.a.cap@2'));
  assert.throws(() => registry.dispatch('dev.test.b.cap@1'), unsupported('HCS-0004-R006', 'dev.test.b.cap@1'));
  assert.throws(() => registry.dispatch('dev.test.c.cap@1'), unsupported('HCS-0004-R005', 'dev.test.c.cap@1'));
  assert.throws(() => registry.dispatch('dev.test.d.cap@1'), unsupported('HCS-0004-R005', 'dev.test.d.cap@1'));
  const snapshot = registry.snapshot();
  assert.equal(snapshot.generation, 3);
  assert.deepEqual([...snapshot.active], [...REWRITE_HOST.builtins, 'dev.test.a.cap@1']);
  assert.deepEqual([...snapshot.draining], ['dev.test.b.cap@1']);
});

test('generation capabilities follow the active generation and see draining entries during a transition', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'hcs-registry-test-'));
  try {
    const source = join(dir, 'source'), storeDir = join(dir, 'store'), stateDir = join(dir, 'state');
    mkdirSync(source); writeFileSync(join(source, 'data'), 'payload');
    const pkg = buildPackage(source);
    mkdirSync(join(storeDir, 'sha256'), { recursive: true });
    writeFileSync(join(storeDir, 'sha256', pkg.contentHash.slice(7)), pkg.bytes);
    const entry = (id: string) => ({ id: `dev.test.${id}`, version: '1', contentHash: pkg.contentHash, size: pkg.size, mediaType: pkg.mediaType, contributions: [{ kind: 'skill', path: 'data', provides: [`dev.test.${id}.cap@1`] }] });
    const catalog = (...entries: unknown[]) => JSON.stringify({ hcsVersion: '0.1', id: 'dev.test.catalog', version: '1', entries });
    const capabilities = generationCapabilities(stateDir);
    assert.deepEqual(capabilities.snapshot(), { generation: null, active: new Set(REWRITE_HOST.builtins), draining: new Set() });
    await applyDesiredSet(catalog(entry('a')), { stateDir, storeDir });
    let snapshot = capabilities.snapshot();
    assert.equal(snapshot.generation, 1);
    assert.ok(snapshot.active.has('dev.test.a.cap@1'));
    assert.equal(loadRegistry(stateDir).dispatch('dev.test.a.cap@1'), 'dev.test.a');
    let during: unknown;
    await applyDesiredSet(catalog(entry('b')), { stateDir, storeDir, activator: {
      activate: async () => {},
      stop: async () => { during = capabilities.snapshot(); assert.throws(() => loadRegistry(stateDir).dispatch('dev.test.a.cap@1'), unsupported('HCS-0004-R006', 'dev.test.a.cap@1')); },
    } });
    assert.deepEqual(during, { generation: 1, active: new Set(REWRITE_HOST.builtins), draining: new Set(['dev.test.a.cap@1']) });
    snapshot = capabilities.snapshot();
    assert.equal(snapshot.generation, 2);
    assert.throws(() => dispatch(snapshot, 'dev.test.a.cap@1'), unsupported('HCS-0004-R005', 'dev.test.a.cap@1'));
    assert.doesNotThrow(() => dispatch(snapshot, 'dev.test.b.cap@1'));
  } finally {
    const unseal = (p: string) => { chmodSync(p, 0o700); for (const e of readdirSync(p, { withFileTypes: true })) if (e.isDirectory()) unseal(join(p, e.name)); };
    unseal(dir); rmSync(dir, { recursive: true, force: true });
  }
});
