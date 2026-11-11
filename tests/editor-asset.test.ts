import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer, request, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { createHandler, type ServerConfig } from '../src/adapters/http-server.ts';
import { Library } from '../src/application/library.ts';
import { tempDir } from './helpers.ts';

// The scene editor module (editor/, built into one file) is served at /review/editor.js.
// The server must work the same without it: the page then uses its plain text field.

const BUNDLE = 'export function createSceneEditor() { return null; } // ñ\n'.repeat(40);

async function start(editorBundle: string): Promise<{ server: Server; port: number }> {
  const server = createServer();
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const port = (server.address() as AddressInfo).port;
  const config: ServerConfig = {
    issuer: 'https://issuer.invalid',
    resource: `http://127.0.0.1:${port}/mcp`,
    reviewOrigin: `http://127.0.0.1:${port}`,
    clerkPublishableKey: 'pk_test_placeholder',
    editorBundle,
  };
  server.on('request', createHandler(config, new Library(tempDir())));
  return { server, port };
}

function get(port: number, path: string, headers: Record<string, string> = {}): Promise<{ status: number; headers: IncomingHttpHeaders; body: Buffer }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.end();
  });
}

test('the built editor module is served as JavaScript, gzipped when asked, and revalidated by its ETag', async (t) => {
  const file = join(tempDir(), 'editor.js');
  writeFileSync(file, BUNDLE);
  const { server, port } = await start(file);
  t.after(() => server.close());

  const plain = await get(port, '/review/editor.js');
  assert.equal(plain.status, 200);
  assert.equal(plain.headers['content-type'], 'text/javascript; charset=utf-8');
  assert.equal(plain.headers['x-content-type-options'], 'nosniff');
  assert.match(String(plain.headers['content-security-policy']), /script-src 'self'/);
  assert.equal(plain.headers['cache-control'], 'no-cache');
  assert.equal(plain.headers.vary, 'Accept-Encoding');
  assert.equal(plain.headers['content-encoding'], undefined);
  assert.ok(plain.body.equals(Buffer.from(BUNDLE)), 'the bytes of the built file');
  const etag = String(plain.headers.etag);
  assert.match(etag, /^W\/"[A-Za-z0-9_-]+"$/);

  const zipped = await get(port, '/review/editor.js', { 'accept-encoding': 'br, gzip' });
  assert.equal(zipped.status, 200);
  assert.equal(zipped.headers['content-encoding'], 'gzip');
  assert.equal(zipped.headers.etag, etag);
  assert.ok(zipped.body.length < plain.body.length, 'smaller on the wire');
  assert.ok(gunzipSync(zipped.body).equals(Buffer.from(BUNDLE)));

  const again = await get(port, '/review/editor.js', { 'if-none-match': etag });
  assert.equal(again.status, 304);
  assert.equal(again.body.length, 0);
  assert.equal(again.headers.etag, etag);
});

test('without a built editor module the address is 404 and the page and its script are served as before', async (t) => {
  const { server, port } = await start(join(tempDir(), 'missing', 'editor.js'));
  t.after(() => server.close());

  const missing = await get(port, '/review/editor.js');
  assert.equal(missing.status, 404);
  const script = await get(port, '/review/app.js');
  assert.equal(script.status, 200);
  assert.equal(script.headers['content-type'], 'text/javascript; charset=utf-8');
  assert.match(script.body.toString(), /import\('\/review\/editor\.js'\)/);
  const page = await get(port, '/review');
  assert.equal(page.status, 200);
  assert.match(String(page.headers['content-security-policy']), /script-src 'self' /);
});

// The graph view is a separate chunk the editor imports only when the Grafo drawing opens
// (docs/notes-and-graph.md). The build lists its chunks in dist/manifest.json, which the server
// reads once at startup; a chunk is served only by an exact name from that list.

const CHUNK = 'export function createGraphView() { return null; } // ñ\n'.repeat(40);

function bundleWithChunks(manifest: unknown, chunks: Record<string, string>): string {
  const dir = tempDir();
  const file = join(dir, 'editor.js');
  writeFileSync(file, BUNDLE);
  mkdirSync(join(dir, 'chunks'));
  for (const [name, text] of Object.entries(chunks)) writeFileSync(join(dir, 'chunks', name), text);
  writeFileSync(join(dir, 'chunks', 'not-listed.js'), CHUNK);
  writeFileSync(join(dir, 'manifest.json'), typeof manifest === 'string' ? manifest : JSON.stringify(manifest));
  return file;
}

test('a chunk named in the manifest is served like the editor module: JavaScript, gzipped when asked, revalidated by its ETag', async (t) => {
  const { server, port } = await start(bundleWithChunks({ chunks: ['graph-view-AB12CD34.js'] }, { 'graph-view-AB12CD34.js': CHUNK }));
  t.after(() => server.close());

  const plain = await get(port, '/review/chunks/graph-view-AB12CD34.js');
  assert.equal(plain.status, 200);
  assert.equal(plain.headers['content-type'], 'text/javascript; charset=utf-8');
  assert.equal(plain.headers['x-content-type-options'], 'nosniff');
  assert.match(String(plain.headers['content-security-policy']), /script-src 'self'/);
  assert.equal(plain.headers['cache-control'], 'no-cache');
  assert.equal(plain.headers.vary, 'Accept-Encoding');
  assert.ok(plain.body.equals(Buffer.from(CHUNK)));
  const etag = String(plain.headers.etag);
  assert.match(etag, /^W\/"[A-Za-z0-9_-]+"$/);
  const editor = await get(port, '/review/editor.js');
  assert.notEqual(editor.headers.etag, etag, 'each file has its own ETag');

  const zipped = await get(port, '/review/chunks/graph-view-AB12CD34.js', { 'accept-encoding': 'gzip' });
  assert.equal(zipped.headers['content-encoding'], 'gzip');
  assert.ok(gunzipSync(zipped.body).equals(Buffer.from(CHUNK)));
  const again = await get(port, '/review/chunks/graph-view-AB12CD34.js', { 'if-none-match': etag });
  assert.equal(again.status, 304);
  assert.equal(again.body.length, 0);
});

test('only an exact manifest name is a chunk: unknown names, dot segments, encoded slashes and stale manifest names are 404', async (t) => {
  // The manifest names a file that no longer exists and one that is not a plain file name.
  const manifest = { chunks: ['graph-view-AB12CD34.js', 'graph-view-OLD00000.js', '../editor.js', 'sub/x.js'] };
  const { server, port } = await start(bundleWithChunks(manifest, { 'graph-view-AB12CD34.js': CHUNK }));
  t.after(() => server.close());

  assert.equal((await get(port, '/review/chunks/graph-view-AB12CD34.js')).status, 200);
  for (const path of [
    '/review/chunks/not-listed.js',
    '/review/chunks/graph-view-OLD00000.js',
    '/review/chunks/graph-view-ab12cd34.js',
    '/review/chunks/graph-view-AB12CD34.js.map',
    '/review/chunks/',
    '/review/chunks/..',
    '/review/chunks/../editor.js/..',
    '/review/chunks/%2e%2e%2feditor.js',
    '/review/chunks/..%2Feditor.js',
    '/review/chunks/sub%2Fx.js',
    '/review/chunks/sub/x.js',
    '/review/chunks/graph-view-AB12CD34.js%00',
    '/review/manifest.json',
    '/review/chunks/manifest.json',
  ]) {
    const response = await get(port, path);
    assert.equal(response.status, 404, path);
    assert.ok(!response.body.equals(Buffer.from(CHUNK)), path);
    assert.ok(!response.body.equals(Buffer.from(BUNDLE)), path);
  }
});

test('without a manifest, or with one that is not valid JSON, the editor module is still served and no chunk is', async (t) => {
  const broken = await start(bundleWithChunks('{"chunks": [', { 'graph-view-AB12CD34.js': CHUNK }));
  t.after(() => broken.server.close());
  assert.equal((await get(broken.port, '/review/editor.js')).status, 200);
  assert.equal((await get(broken.port, '/review/chunks/graph-view-AB12CD34.js')).status, 404);

  const file = join(tempDir(), 'editor.js');
  writeFileSync(file, BUNDLE);
  const none = await start(file);
  t.after(() => none.server.close());
  assert.equal((await get(none.port, '/review/editor.js')).status, 200);
  assert.equal((await get(none.port, '/review/chunks/graph-view-AB12CD34.js')).status, 404);
});
