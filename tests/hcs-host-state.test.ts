import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildPackage } from '../src/hcs/package.ts';
import { validateEntryStatus } from '../src/hcs/lifecycle.ts';
import { HcsFailure } from '../src/hcs/errors.ts';
import { grantPermission, revokePermission } from '../src/hcs/grants.ts';
import { applyDesiredSet, statusReport, HostBusyError, type Activator } from '../src/hcs/host-state.ts';

interface Fixture {
  stateDir: string; storeDir: string; badHash: string;
  entry: (id: string, extra?: Record<string, unknown>) => Record<string, unknown>;
  catalog: (...entries: unknown[]) => string;
}

function unseal(path: string): void {
  chmodSync(path, 0o700);
  for (const e of readdirSync(path, { withFileTypes: true })) if (e.isDirectory()) unseal(join(path, e.name));
}

function fixture(fn: (f: Fixture) => Promise<void>) {
  return async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hcs-host-test-'));
    try {
      const source = join(dir, 'source'), storeDir = join(dir, 'store'), stateDir = join(dir, 'state');
      mkdirSync(source); writeFileSync(join(source, 'data'), 'payload');
      const pkg = buildPackage(source); mkdirSync(join(storeDir, 'sha256'), { recursive: true });
      writeFileSync(join(storeDir, 'sha256', pkg.contentHash.slice(7)), pkg.bytes);
      // A store object whose bytes do not match the hash it is stored under.
      const badHash = `sha256:${'0'.repeat(64)}`;
      writeFileSync(join(storeDir, 'sha256', '0'.repeat(64)), pkg.bytes);
      const entry = (id: string, extra = {}) => ({ id: `dev.test.${id}`, version: '1', contentHash: pkg.contentHash, size: pkg.size, mediaType: pkg.mediaType, contributions: [{ kind: 'skill', path: 'data', provides: [`dev.test.${id}.cap@1`] }], ...extra });
      const catalog = (...entries: unknown[]) => JSON.stringify({ hcsVersion: '0.1', id: 'dev.test.catalog', version: '1', entries });
      await fn({ stateDir, storeDir, badHash, entry, catalog });
    } finally {
      unseal(dir); rmSync(dir, { recursive: true, force: true });
    }
  };
}

const pointer = (stateDir: string) => existsSync(join(stateDir, 'active')) ? JSON.parse(readFileSync(join(stateDir, 'active'), 'utf8')).generation : null;
const states = (stateDir: string) => statusReport(stateDir).map(s => [s.entry, s.state, s.error?.code ?? null]);
const never = () => new Promise<never>(() => {});

function treeHash(dir: string): string {
  const hash = createHash('sha256');
  const walk = (path: string, rel: string) => {
    for (const name of readdirSync(path).sort()) {
      const full = join(path, name), stat = statSync(full);
      hash.update(`${rel}/${name}:${stat.mode.toString(8)}\n`);
      if (stat.isDirectory()) walk(full, `${rel}/${name}`); else hash.update(readFileSync(full));
    }
  };
  walk(dir, '');
  return hash.digest('hex');
}

function failure(check: (e: HcsFailure) => void) {
  return (e: unknown) => { assert.ok(e instanceof HcsFailure, String(e)); check(e); return true; };
}

test('applies a desired set as a new immutable generation and switches the pointer once', fixture(async ({ stateDir, storeDir, entry, catalog }) => {
  const seen: string[] = [];
  const activator: Activator = {
    activate: async (e, dir) => {
      // R001: package content is only handed over once the entry is prepared and the pointer names its generation.
      seen.push(`${e.id}:${readFileSync(join(dir, 'data'), 'utf8')}:${pointer(stateDir)}:${dir === join(stateDir, 'generations', '1', 'entries', e.id)}`);
    },
    stop: async () => {},
  };
  const result = await applyDesiredSet(catalog(entry('b', { requires: ['dev.test.a.cap@1'] }), entry('a')), { stateDir, storeDir, activator });
  assert.equal(result.generation, 1);
  assert.deepEqual(seen, ['dev.test.a:payload:1:true', 'dev.test.b:payload:1:true']);
  assert.equal(pointer(stateDir), 1);
  assert.deepEqual(states(stateDir), [['dev.test.a', 'active', null], ['dev.test.b', 'active', null]]);
  assert.deepEqual(result.status, statusReport(stateDir));
  assert.deepEqual(statusReport(stateDir).flatMap(s => validateEntryStatus(s)), []);
  const generation = JSON.parse(readFileSync(join(stateDir, 'generations/1/generation.json'), 'utf8'));
  assert.deepEqual({ id: generation.catalog.id, version: generation.catalog.version }, { id: 'dev.test.catalog', version: '1' });
  assert.deepEqual(generation.entries.map((e: { id: string }) => e.id), ['dev.test.a', 'dev.test.b']);
  // Sealed: files and directories of a prepared generation are read-only.
  assert.equal(statSync(join(stateDir, 'generations/1')).mode & 0o222, 0);
  assert.equal(statSync(join(stateDir, 'generations/1/generation.json')).mode & 0o222, 0);
  assert.equal(statSync(join(stateDir, 'generations/1/entries/dev.test.a/data')).mode & 0o222, 0);
  assert.equal(existsSync(join(stateDir, 'lock')), false);
}));

test('resolution errors keep the previous generation active and do not modify it', fixture(async ({ stateDir, storeDir, entry, catalog }) => {
  const options = { stateDir, storeDir };
  await applyDesiredSet(catalog(entry('a')), options);
  const before = treeHash(join(stateDir, 'generations/1'));
  await assert.rejects(applyDesiredSet(catalog(entry('a'), entry('b', { requires: ['dev.test.missing@1'] })), options), failure(e => {
    assert.deepEqual(e.errors.map(x => [x.code, x.entry]), [['missing_dependency', 'dev.test.b']]);
  }));
  assert.equal(pointer(stateDir), 1);
  assert.deepEqual(readdirSync(join(stateDir, 'generations')), ['1']);
  assert.deepEqual(states(stateDir), [['dev.test.a', 'active', null], ['dev.test.b', 'failed', 'missing_dependency']]);
  assert.deepEqual(statusReport(stateDir).flatMap(s => validateEntryStatus(s)), []);
  await assert.rejects(applyDesiredSet('{"hcsVersion":"0.1"}', options), failure(e => assert.equal(e.errors[0].code, 'manifest_invalid')));
  assert.equal(pointer(stateDir), 1);
  await applyDesiredSet(catalog(entry('b')), options);
  assert.equal(pointer(stateDir), 2);
  assert.deepEqual(states(stateDir), [['dev.test.b', 'active', null]]);
  // HCS-0007-R017: a later apply never modifies a prepared generation.
  assert.equal(treeHash(join(stateDir, 'generations/1')), before);
}));

test('integrity and authorization failures keep the previous generation without preparing a new one', fixture(async ({ stateDir, storeDir, badHash, entry, catalog }) => {
  await applyDesiredSet(catalog(entry('a')), { stateDir, storeDir });
  await assert.rejects(applyDesiredSet(catalog(entry('b', { contentHash: badHash })), { stateDir, storeDir }), failure(e => {
    assert.deepEqual(e.errors.map(x => [x.code, x.entry]), [['integrity_mismatch', 'dev.test.b']]);
  }));
  await assert.rejects(applyDesiredSet(catalog(entry('c')), { stateDir, storeDir, authorize: async e => e.id !== 'dev.test.c' }), failure(e => {
    assert.deepEqual(e.errors.map(x => [x.code, x.entry]), [['permission_denied', 'dev.test.c']]);
  }));
  assert.equal(pointer(stateDir), 1);
  assert.deepEqual(readdirSync(join(stateDir, 'generations')), ['1']);
  assert.deepEqual(states(stateDir), [['dev.test.a', 'active', null], ['dev.test.c', 'failed', 'permission_denied']]);
}));

test('activation failure rolls back every entry, stopping in reverse activation order', fixture(async ({ stateDir, storeDir, entry, catalog }) => {
  const events: string[] = [];
  const activator: Activator = {
    activate: async e => { events.push(`+${e.id}`); if (e.id.endsWith('.d')) throw Error('bad'); },
    stop: async e => { events.push(`-${e.id}`); },
  };
  const options = { stateDir, storeDir, activator };
  await applyDesiredSet(catalog(entry('old1'), entry('old2')), options); events.length = 0;
  await assert.rejects(applyDesiredSet(catalog(entry('a'), entry('b'), entry('d')), options), failure(e => {
    assert.deepEqual(e.errors.map(x => [x.code, x.entry]), [['plugin_failed', 'dev.test.d']]);
  }));
  assert.equal(pointer(stateDir), 1);
  assert.deepEqual(events, ['-dev.test.old2', '-dev.test.old1', '+dev.test.a', '+dev.test.b', '+dev.test.d', '-dev.test.b', '-dev.test.a', '+dev.test.old1', '+dev.test.old2']);
  assert.deepEqual(states(stateDir), [['dev.test.old1', 'active', null], ['dev.test.old2', 'active', null], ['dev.test.d', 'failed', 'plugin_failed']]);
  assert.deepEqual(statusReport(stateDir).flatMap(s => validateEntryStatus(s)), []);
}));

test('a step over the deadline aborts its signal, fails with timeout and rolls back', fixture(async ({ stateDir, storeDir, entry, catalog }) => {
  let aborted = false; const stopped: string[] = [];
  const activator: Activator = {
    activate: async (e, _dir, signal) => {
      if (!e.id.endsWith('.b')) return;
      signal.addEventListener('abort', () => { aborted = true; });
      await never();
    },
    stop: async e => { stopped.push(e.id); },
  };
  await assert.rejects(applyDesiredSet(catalog(entry('a'), entry('b')), { stateDir, storeDir, activator, stepDeadlineMs: 20 }), failure(e => {
    assert.deepEqual(e.errors.map(x => [x.code, x.entry, x.requirement]), [['timeout', 'dev.test.b', 'HCS-0004-R007']]);
  }));
  assert.equal(aborted, true);
  assert.deepEqual(stopped, ['dev.test.a']);
  assert.equal(pointer(stateDir), null);
  assert.deepEqual(states(stateDir), [['dev.test.b', 'failed', 'timeout']]);
}));

test('failed or timed-out rollback steps are reported as incomplete and the pointer is still restored', fixture(async ({ stateDir, storeDir, entry, catalog }) => {
  const activator: Activator = {
    activate: async e => { if (e.id.endsWith('.d')) await never(); if (e.id.endsWith('.old2') && failing) throw Error('restart failed'); },
    // dev.test.a ignores its signal and never settles; dev.test.b throws.
    stop: async e => { if (e.id.endsWith('.a') && failing) await never(); if (e.id.endsWith('.b') && failing) throw Error('stop failed'); },
  };
  let failing = false;
  await applyDesiredSet(catalog(entry('old1'), entry('old2')), { stateDir, storeDir, activator });
  failing = true;
  const started = Date.now();
  await assert.rejects(applyDesiredSet(catalog(entry('a'), entry('b'), entry('d')), { stateDir, storeDir, activator, stepDeadlineMs: 20 }), failure(e => {
    assert.deepEqual(e.errors.map(x => [x.code, x.entry, x.details?.['x-rewrite-rollback'] ?? null]), [
      ['timeout', 'dev.test.d', null], ['plugin_failed', 'dev.test.b', 'incomplete'], ['timeout', 'dev.test.a', 'incomplete'], ['plugin_failed', 'dev.test.old2', 'incomplete'],
    ]);
  }));
  assert.ok(Date.now() - started < 5000);
  assert.equal(pointer(stateDir), 1);
  assert.deepEqual(states(stateDir), [['dev.test.old1', 'active', null], ['dev.test.old2', 'failed', 'plugin_failed'], ['dev.test.a', 'failed', 'timeout'], ['dev.test.b', 'failed', 'plugin_failed'], ['dev.test.d', 'failed', 'timeout']]);
  assert.deepEqual(statusReport(stateDir).flatMap(s => validateEntryStatus(s)), []);
  assert.equal(existsSync(join(stateDir, 'lock')), false);
}));

test('a concurrent writer is refused until the lock is released', fixture(async ({ stateDir, storeDir, entry, catalog }) => {
  let release!: () => void; let entered!: () => void;
  const ready = new Promise<void>(r => { entered = r; }); const wait = new Promise<void>(r => { release = r; });
  const first = applyDesiredSet(catalog(entry('a')), { stateDir, storeDir, activator: { activate: async () => { entered(); await wait; }, stop: async () => {} } });
  await ready;
  assert.deepEqual(JSON.parse(readFileSync(join(stateDir, 'lock'), 'utf8')).pid, process.pid);
  await assert.rejects(applyDesiredSet(catalog(entry('b')), { stateDir, storeDir }), HostBusyError);
  release(); await first;
  assert.equal(existsSync(join(stateDir, 'lock')), false);
  await applyDesiredSet(catalog(entry('b')), { stateDir, storeDir });
  assert.equal(pointer(stateDir), 2);
}));

test('a lock left by a dead process is taken over', fixture(async ({ stateDir, storeDir, entry, catalog }) => {
  const dead = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' });
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(join(stateDir, 'lock'), JSON.stringify({ pid: Number(dead.stdout), at: new Date(0).toISOString() }));
  await applyDesiredSet(catalog(entry('a')), { stateDir, storeDir });
  assert.equal(pointer(stateDir), 1);
  assert.equal(existsSync(join(stateDir, 'lock')), false);
}));

// A package whose root holds an HCS-0005 request document, stored where the host fetches it.
function requestingPackage(dir: string, storeDir: string, id: string, document: unknown) {
  const source = mkdtempSync(join(dir, 'requests-'));
  writeFileSync(join(source, 'data'), 'payload');
  if (document !== undefined) writeFileSync(join(source, 'requests.json'), typeof document === 'string' ? document : JSON.stringify(document));
  const pkg = buildPackage(source);
  mkdirSync(join(storeDir, 'sha256'), { recursive: true });
  writeFileSync(join(storeDir, 'sha256', pkg.contentHash.slice(7)), pkg.bytes);
  return { id, version: '1', contentHash: pkg.contentHash, size: pkg.size, mediaType: pkg.mediaType, contributions: [{ kind: 'skill', path: 'data', provides: [`${id}.cap@1`] }] };
}

test('by default an entry is authorized only when every permission its package requests is granted (HCS-0005-R001, R002, R004)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'hcs-host-grants-'));
  try {
    const storeDir = join(dir, 'store'), stateDir = join(dir, 'state'), grantsDir = join(dir, 'data');
    const read = 'com.fullfran.rewrite.book.read', propose = 'com.fullfran.rewrite.claims.propose';
    const id = 'dev.test.reader';
    const requests = { hcsVersion: '0.1', entry: id, requests: [
      { permission: read, reason: 'read scenes', 'x-example-autogrant': true }, { permission: propose },
    ] };
    const entry = requestingPackage(dir, storeDir, id, requests);
    const apply = () => applyDesiredSet(JSON.stringify({ hcsVersion: '0.1', id: 'dev.test.catalog', version: '1', entries: [entry] }), { stateDir, storeDir, grantsDir });
    const denied = (permission: string) => failure(e => {
      assert.deepEqual(e.errors.map(x => [x.code, x.entry, x.requirement, x.message]), [['permission_denied', id, 'HCS-0005-R001', `Permission denied: ${permission}`]]);
    });
    // A request, even with an extension member, is not a grant.
    await assert.rejects(apply(), denied(read));
    assert.equal(pointer(stateDir), null);
    assert.deepEqual(states(stateDir), [[id, 'failed', 'permission_denied']]);
    grantPermission(grantsDir, id, read);
    await assert.rejects(apply(), denied(propose));
    grantPermission(grantsDir, id, propose);
    assert.equal((await apply()).generation, 1);
    assert.deepEqual(states(stateDir), [[id, 'active', null]]);
    revokePermission(grantsDir, id, propose);
    await assert.rejects(apply(), denied(propose));
    assert.equal(pointer(stateDir), 1, 'a denied transition keeps the previous generation');

    // A package without a request document requests nothing; a malformed or foreign document is denied.
    const plain = requestingPackage(dir, storeDir, 'dev.test.plain', undefined);
    const applyOne = (e: unknown) => applyDesiredSet(JSON.stringify({ hcsVersion: '0.1', id: 'dev.test.catalog', version: '2', entries: [e] }), { stateDir, storeDir, grantsDir });
    assert.equal((await applyOne(plain)).generation, 2);
    for (const [name, document] of [
      ['other', { ...requests, entry: 'dev.test.other' }], ['version', { ...requests, hcsVersion: '9' }],
      ['member', { ...requests, grants: [] }], ['permission', { ...requests, requests: [{ permission: 'Not An Id' }] }],
      ['json', '{nope'],
    ] as [string, unknown][]) {
      const bad = requestingPackage(dir, storeDir, `dev.test.bad-${name}`, document);
      await assert.rejects(applyOne(bad), failure(e => {
        assert.equal(e.errors[0].code, 'permission_denied', name);
        assert.equal(e.errors[0].entry, bad.id, name);
      }));
    }
    assert.equal(pointer(stateDir), 2);
  } finally {
    unseal(dir); rmSync(dir, { recursive: true, force: true });
  }
});
