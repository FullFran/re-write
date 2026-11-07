// scripts/hcs-sync.ts vendors one pinned HCS release. No network: the release is a tarball built here and served
// from 127.0.0.1.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { gzipSync } from 'node:zlib';
import { writeTar, type TarInput } from '../src/hcs/tar.ts';
import { releaseUrl, unpackRelease, verifyTree } from '../src/hcs/vendor.ts';

const SCRIPT = resolve(import.meta.dirname, '..', 'scripts', 'hcs-sync.ts');
const VERSION = '0.1.9-draft.1';
const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

/** Release files plus a SHA256SUMS over them; `sums` overrides lines to build a broken release. */
function release(extra: Record<string, string> = {}, sums: Record<string, string> = {}): Buffer {
  const files: Record<string, string> = { 'index.json': `{"indexFormat":1,"release":"${VERSION}"}\n`, 'spec/HCS-0000.md': '# Conventions\n', ...extra };
  const lines = Object.keys(files).sort().map(name => `${sums[name] ?? sha256(Buffer.from(files[name]))}  ${name}`);
  const members: TarInput[] = [{ name: `hcs-${VERSION}`, type: 'directory' }, { name: `hcs-${VERSION}/spec`, type: 'directory' }];
  for (const [name, content] of Object.entries({ ...files, SHA256SUMS: `${lines.join('\n')}\n` })) members.push({ name: `hcs-${VERSION}/${name}`, data: Buffer.from(content) });
  return gzipSync(writeTar(members));
}

async function serve(t: import('node:test').TestContext, body: Buffer | null): Promise<string> {
  const server = createServer((_request, response) => {
    if (!body) { response.writeHead(404).end(); return; }
    response.writeHead(200, { 'content-type': 'application/gzip', 'content-length': body.length }).end(body);
  });
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  t.after(() => new Promise<void>(done => server.close(() => done())));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}/hcs.tar.gz`;
}

function scratch(t: import('node:test').TestContext): string {
  const dir = mkdtempSync(join(tmpdir(), 'rewrite-hcs-sync-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function sync(...args: string[]): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((done, fail) => {
    const child = spawn(process.execPath, [SCRIPT, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', fail);
    child.on('close', status => done({ status, stdout, stderr }));
  });
}

/** Every file under `dir`, with its content, to show a refused sync changed nothing. */
function snapshot(dir: string): Record<string, string> {
  const files: Record<string, string> = {};
  const visit = (path: string, prefix: string) => {
    if (!existsSync(path)) return;
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const name = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) visit(join(path, entry.name), name);
      else files[name] = readFileSync(join(path, entry.name), 'utf8');
    }
  };
  visit(dir, '');
  return files;
}

test('vendors a release whose digest and SHA256SUMS match, and pins the release URL', async (t) => {
  const tarball = release();
  const url = await serve(t, tarball);
  const root = scratch(t);
  const result = await sync(VERSION, sha256(tarball), '--url', url, '--root', root);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, `HCS ${VERSION}: 2 files checked against SHA256SUMS, vendored in vendor/hcs/${VERSION}, pin in vendor/hcs/PIN.json.\n`);
  assert.equal(result.stderr, '');
  const dir = join(root, 'vendor', 'hcs', VERSION);
  assert.equal(verifyTree(dir), 2);
  assert.equal(readFileSync(join(dir, 'spec', 'HCS-0000.md'), 'utf8'), '# Conventions\n');
  assert.deepEqual(JSON.parse(readFileSync(join(root, 'vendor', 'hcs', 'PIN.json'), 'utf8')), { version: VERSION, sha256: sha256(tarball), url: releaseUrl(VERSION) });
  assert.deepEqual(readdirSync(join(root, 'vendor', 'hcs')).sort(), [VERSION, 'PIN.json'].sort());
});

test('refuses a tarball whose digest is not the pinned one and keeps the previous tree and pin', async (t) => {
  const tarball = release();
  const url = await serve(t, tarball);
  const root = scratch(t);
  mkdirSync(join(root, 'vendor', 'hcs', VERSION), { recursive: true });
  writeFileSync(join(root, 'vendor', 'hcs', VERSION, 'previous.txt'), 'previous tree\n');
  writeFileSync(join(root, 'vendor', 'hcs', 'PIN.json'), '{"previous":true}\n');
  const before = snapshot(root);
  const pinned = '0'.repeat(64);
  const result = await sync(VERSION, pinned, '--url', url, '--root', root);
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, `hcs-sync: the downloaded tarball has sha256 ${sha256(tarball)}, the pin says ${pinned}: refused\n`);
  assert.deepEqual(snapshot(root), before);
});

test('refuses a release whose files do not match its SHA256SUMS and writes nothing', async (t) => {
  const tarball = release({}, { 'spec/HCS-0000.md': 'f'.repeat(64) });
  const url = await serve(t, tarball);
  const root = scratch(t);
  const result = await sync(VERSION, sha256(tarball), '--url', url, '--root', root);
  assert.equal(result.status, 1);
  assert.equal(result.stderr, 'hcs-sync: HCS release integrity check failed:\n  spec/HCS-0000.md: sha256 differs from SHA256SUMS\n');
  assert.deepEqual(snapshot(root), {});
});

test('reports an unavailable release', async (t) => {
  const url = await serve(t, null);
  const root = scratch(t);
  const result = await sync(VERSION, 'a'.repeat(64), '--url', url, '--root', root);
  assert.equal(result.status, 1);
  assert.equal(result.stderr, `hcs-sync: GET ${url}: HTTP 404\n`);
  assert.deepEqual(snapshot(root), {});
});

test('usage errors exit 2 without downloading', async (t) => {
  const root = scratch(t);
  const usage = 'usage: node scripts/hcs-sync.ts <version> <sha256> [--url <tarball URL>] [--root <repository>]';
  for (const [args, message] of [
    [[VERSION], 'expected <version> <sha256>'],
    [[VERSION, 'a'.repeat(64), '--bogus'], 'unknown option --bogus'],
    [[VERSION, 'a'.repeat(64), '--url'], '--url needs a value'],
    [['v0.1.0', 'a'.repeat(64)], "not a release version: 'v0.1.0'"],
    [['0.2.0', 'a'.repeat(64)], '0.2.0 is not a release of contract 0.1; change HCS_VERSION first'],
    [[VERSION, 'A'.repeat(64)], `not a lowercase sha256 digest: '${'A'.repeat(64)}'`],
  ] as const) {
    const result = await sync('--root', root, ...args);
    assert.equal(result.status, 2, message);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, `hcs-sync: ${message}\n${usage}\n`);
  }
  assert.deepEqual(snapshot(root), {});
});

/** One ustar header block followed by its data; `name` may be anything, including unsafe paths. */
function rawMember(name: string, type: string, data = Buffer.alloc(0)): Buffer {
  const header = Buffer.alloc(512);
  header.write(name, 0, 100);
  header.write('0000644\0', 100); header.write('0000000\0', 108); header.write('0000000\0', 116);
  header.write(`${data.length.toString(8).padStart(11, '0')}\0`, 124); header.write('00000000000\0', 136);
  header.fill(32, 148, 156); header.write(type, 156); header.write('ustar\0', 257); header.write('00', 263);
  header.write(`${header.reduce((a, b) => a + b, 0).toString(8).padStart(6, '0')}\0 `, 148);
  return Buffer.concat([header, data, Buffer.alloc((512 - (data.length % 512)) % 512)]);
}
const archive = (...members: Buffer[]) => gzipSync(Buffer.concat([...members, Buffer.alloc(1024)]));

test('applies pax path records, as the published releases use them for long names', () => {
  const long = `hcs-${VERSION}/conformance/cases/${'x'.repeat(120)}.json`;
  const record = (text: string) => { let size = text.length + 3; while (`${size} ${text}\n`.length !== size) size++; return `${size} ${text}\n`; };
  const files = unpackRelease(archive(rawMember('././@PaxHeader', 'x', Buffer.from(record(`path=${long}`))), rawMember('truncated-name', '0', Buffer.from('case\n'))), VERSION);
  assert.deepEqual([...files.keys()], [long.slice(`hcs-${VERSION}/`.length)]);
});

test('refuses links, special files and paths outside the release folder', () => {
  for (const [member, message] of [
    [rawMember(`hcs-${VERSION}/link`, '2'), /not a regular file or folder/],
    [rawMember(`hcs-${VERSION}/fifo`, '6'), /not a regular file or folder/],
    [rawMember(`hcs-${VERSION}/../escape.txt`, '0'), /unsafe path/],
    [rawMember('/etc/escape.txt', '0'), /unsafe path/],
    [rawMember('other/file.txt', '0'), /outside hcs-/],
  ] as const) {
    assert.throws(() => unpackRelease(archive(member), VERSION), message);
  }
});
