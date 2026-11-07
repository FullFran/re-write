import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, statSync, chmodSync, rmSync, readdirSync, symlinkSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { buildPackage, verifyPackage, unpackPackage, fetchPackageBytes } from '../src/hcs/package.ts';
import { writeTar } from '../src/hcs/tar.ts';

function scratch(fn: (dir: string) => Promise<void> | void) {
  return async () => { const dir = mkdtempSync(join(tmpdir(), 'rewrite-package-test-')); try { await fn(dir); } finally { chmodTree(dir); rmSync(dir, { recursive: true, force: true }); } };
}
function chmodTree(dir: string) { if (!existsSync(dir)) return; chmodSync(dir, 0o700); for (const e of readdirSync(dir, { withFileTypes: true })) if (e.isDirectory()) chmodTree(join(dir, e.name)); }
function expected(bytes: Buffer, algorithm = 'sha256') { return { size: bytes.length, contentHash: `${algorithm}:${createHash(algorithm).update(bytes).digest('hex')}` }; }
function unsafe(name: string, type = '0') {
  const tar = writeTar([{ name: 'placeholder' }]);
  tar.fill(0, 0, 100); tar.write(name, 0, 100); tar.write(type, 156);
  tar.fill(32, 148, 156); const sum = tar.subarray(0, 512).reduce((a, b) => a + b, 0);
  tar.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8, 'ascii'); return gzipSync(tar);
}
function mismatch(error: any) { assert.equal(error.errors?.[0]?.code, 'integrity_mismatch'); return true; }

test('build is deterministic across order and timestamps with fixed gzip header', scratch(dir => {
  const a = join(dir, 'a'), b = join(dir, 'b'); mkdirSync(a); mkdirSync(b);
  mkdirSync(join(a, 'd')); writeFileSync(join(a, 'd', 'z'), 'z'); writeFileSync(join(a, 'a'), 'a');
  writeFileSync(join(b, 'a'), 'a'); mkdirSync(join(b, 'd')); writeFileSync(join(b, 'd', 'z'), 'z'); utimesSync(join(a, 'a'), 1, 1);
  const one = buildPackage(a), two = buildPackage(b); assert.deepEqual(one.bytes, two.bytes);
  assert.match(one.contentHash, /^sha256:[a-f0-9]{64}$/); assert.deepEqual(expected(one.bytes), { size: one.size, contentHash: one.contentHash });
  assert.equal(one.mediaType, 'application/vnd.oci.image.layer.v1.tar+gzip'); assert.equal(one.bytes.readUInt32LE(4), 0); assert.equal(one.bytes[3] & 8, 0);
  symlinkSync('a', join(a, 'link')); assert.throws(() => buildPackage(a));
}));

test('verification checks size then sha256 and sha512 before writing', scratch(dir => {
  const bytes = gzipSync(writeTar([{ name: 'file', data: Buffer.from('ok') }]));
  verifyPackage(bytes, expected(bytes)); verifyPackage(bytes, expected(bytes, 'sha512'));
  for (const exp of [{ ...expected(bytes), size: bytes.length + 1 }, { ...expected(bytes), contentHash: 'sha256:' + '0'.repeat(64) }]) {
    assert.throws(() => verifyPackage(bytes, exp), mismatch); const target = join(dir, 'out');
    assert.throws(() => unpackPackage(bytes, exp, target), mismatch); assert.equal(existsSync(target), false);
  }
}));

test('unsafe members are rejected with typed details and no leftovers', scratch(dir => {
  for (const [name, type] of [['/abs','0'], ['a/../b','0'], ['a\\b','0'], ['.wh.foo','0'], ['.wh..wh..opq','0'], ['link','1'], ['link','2'], ['device','3'], ['device','4'], ['pipe','6']]) {
    const bytes = unsafe(name, type), target = join(dir, 'out');
    assert.throws(() => unpackPackage(bytes, expected(bytes), target), (e: any) => { mismatch(e); assert.equal(e.errors[0].details['x-rewrite-archive'], 'unsafe-member'); assert.equal(e.errors[0].details['x-rewrite-member'], name); assert.ok(e.errors[0].details['x-rewrite-reason']); return true; });
    assert.equal(existsSync(target), false); assert.deepEqual(readdirSync(dir), []);
  }
  const dup = gzipSync(writeTar([{ name: 'a' }, { name: 'a' }])); assert.throws(() => unpackPackage(dup, expected(dup), join(dir, 'out')), mismatch);
}));

test('hidden NUL name bytes are unsafe and malformed tar is rejected before extraction', scratch(dir => {
  for (const offset of [0, 345]) {
    const tar = writeTar([{ name: 'safe' }]);
    tar.fill(0, offset, offset + (offset === 0 ? 100 : 155)); tar.write('safe\0hidden', offset);
    tar.fill(32, 148, 156);
    tar.write(tar.subarray(0, 512).reduce((a, b) => a + b, 0).toString(8).padStart(6, '0') + '\0 ', 148, 8, 'ascii');
    const bytes = gzipSync(tar);
    assert.throws(() => unpackPackage(bytes, expected(bytes), join(dir, 'out')), (e: any) => {
      mismatch(e); assert.equal(e.errors[0].details['x-rewrite-archive'], 'unsafe-member');
      assert.ok(e.errors[0].details['x-rewrite-member']); assert.ok(e.errors[0].details['x-rewrite-reason']); return true;
    });
    assert.deepEqual(readdirSync(dir), []);
  }
  const tar = writeTar([{ name: 'file' }]); tar[0] ^= 1;
  const bytes = gzipSync(tar);
  assert.throws(() => unpackPackage(bytes, expected(bytes), join(dir, 'out')), /checksum/);
  assert.deepEqual(readdirSync(dir), []);
}));

test('extraction failure removes a partially populated directory', scratch(dir => {
  const bytes = gzipSync(writeTar([{ name: 'a', data: Buffer.from('written') }, { name: 'a/child', data: Buffer.from('failure') }]));
  assert.throws(() => unpackPackage(bytes, expected(bytes), join(dir, 'out')));
  assert.deepEqual(readdirSync(dir), []);
}));

test('unpack enforces limits, seals files and directories, and requires a fresh target', scratch(dir => {
  const bytes = gzipSync(writeTar([{ name: 'd/', type: 'directory' }, { name: 'd/f', data: Buffer.from('hello') }]));
  for (const limits of [{ maxBytes: 4 }, { maxMembers: 1 }]) { assert.throws(() => unpackPackage(bytes, expected(bytes), join(dir, 'out'), limits)); assert.deepEqual(readdirSync(dir), []); }
  const target = join(dir, 'out'); unpackPackage(bytes, expected(bytes), target);
  assert.equal(readFileSync(join(target, 'd/f'), 'utf8'), 'hello'); assert.equal(statSync(target).mode & 0o777, 0o555); assert.equal(statSync(join(target, 'd')).mode & 0o777, 0o555); assert.equal(statSync(join(target, 'd/f')).mode & 0o777, 0o444);
  assert.throws(() => unpackPackage(bytes, expected(bytes), target));
}));

// Replaces global fetch while `fn` runs; `handler` sees each requested URL and its abort signal.
async function withFetch(handler: (url: string, signal: AbortSignal) => Promise<Response>, fn: () => Promise<void>) {
  const original = globalThis.fetch;
  globalThis.fetch = ((url: URL | string, init?: RequestInit) => handler(String(url), init!.signal!)) as typeof fetch;
  try { await fn(); } finally { globalThis.fetch = original; }
}

test('fetch prefers the local content store, then tries https locations in order', scratch(async dir => {
  const store = join(dir, 'store'), local = join(store, 'sha256'); mkdirSync(local, { recursive: true });
  const entry = { ...expected(Buffer.from('stored')), locations: ['https://packages.invalid/first', 'https://packages.invalid/second'] };
  writeFileSync(join(local, entry.contentHash.slice(7)), 'stored'); assert.equal((await fetchPackageBytes(entry, { storeDir: store })).toString(), 'stored');
  const requested: string[] = [];
  await withFetch(async url => { requested.push(url); return url.endsWith('/missing') ? new Response('', { status: 404 }) : new Response(url.endsWith('/first') ? 'first' : 'second'); }, async () => {
    const missing = { ...entry, contentHash: expected(Buffer.from('missing')).contentHash, locations: ['https://packages.invalid/missing', ...entry.locations] };
    assert.equal((await fetchPackageBytes(missing, { storeDir: store })).toString(), 'first');
  });
  assert.deepEqual(requested, ['https://packages.invalid/missing', 'https://packages.invalid/first']);
}));

test('fetch refuses file: locations like any other unsupported location', scratch(async dir => {
  const outside = join(dir, 'outside'); writeFileSync(outside, 'secret');
  const entry = { ...expected(Buffer.from('secret')), locations: [pathToFileURL(outside).href] };
  await assert.rejects(fetchPackageBytes(entry, { storeDir: join(dir, 'store') }), /Unsupported package location/);
  // A refused location does not stop the next one from being tried.
  await withFetch(async () => new Response('secret'), async () => {
    assert.equal((await fetchPackageBytes({ ...entry, locations: [...entry.locations, 'https://packages.invalid/p'] }, { storeDir: join(dir, 'store') })).toString(), 'secret');
  });
}));

test('fetch aborts the download when the caller signal aborts', scratch(async dir => {
  let downloadSignal: AbortSignal | undefined;
  await withFetch((_url, signal) => { downloadSignal = signal; return new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason))); }, async () => {
    const controller = new AbortController();
    const entry = { ...expected(Buffer.from('remote')), locations: ['https://packages.invalid/p'] };
    const pending = fetchPackageBytes(entry, { storeDir: join(dir, 'store'), signal: controller.signal });
    const outcome = pending.then(() => 'resolved', () => 'rejected');
    await new Promise(r => setTimeout(r, 10));
    controller.abort(new Error('deadline'));
    assert.equal(await Promise.race([outcome, new Promise(r => setTimeout(() => r('pending'), 200))]), 'rejected');
    assert.equal(downloadSignal?.aborted, true);
  });
}));
