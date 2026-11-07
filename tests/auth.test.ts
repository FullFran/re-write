import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { after, before, test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { base64url, generateSecret, SignJWT } from 'jose';
import { readConfig } from '../src/adapters/http-server.ts';
import { HcsFailure, hcsError } from '../src/hcs/errors.ts';
import { startHarness, type Harness } from './server-helpers.ts';

let h: Harness;
before(async () => { h = await startHarness(); });
after(() => h.close());

const INIT = {
  jsonrpc: '2.0', id: 1, method: 'initialize',
  params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } },
};

function post(token?: string, body: unknown = INIT, headers: Record<string, string> = {}) {
  return fetch(h.resource, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

test('HTTP problem responses carry HCS errors and preserve product statuses', async () => {
  const refusal = await fetch(`${h.base}/missing`);
  assert.equal(refusal.status, 404);
  assert.match(refusal.headers.get('content-type')!, /^application\/problem\+json/);
  const problem = await refusal.json();
  assert.match(problem.type, /^https:\/\/github\.com\/FullFran\/re-write\/blob\/main\/docs\/problems\.md#/);
  assert.equal('hcsError' in problem, false);
  const error = hcsError('timeout', 'Timed out');
  const original = h.library.booksFor;
  h.library.booksFor = () => { throw new HcsFailure([error]); };
  try {
    const response = await fetch(`${h.base}/review/api/books`, { headers: { authorization: `Bearer ${await h.session()}` } });
    assert.equal(response.status, 504);
    assert.match(response.headers.get('content-type')!, /^application\/problem\+json/);
    const body = await response.json();
    assert.equal(body.type, 'urn:hcs:error:timeout');
    assert.deepEqual(body.hcsError, error);
    assert.equal('x-rewrite-errors' in body, false);
    const rpc = await post(await h.access(), { jsonrpc: '2.0', id: 42, method: 'tools/call', params: { name: 'list_books', arguments: {} } });
    assert.equal(rpc.status, 200);
    assert.deepEqual(await rpc.json(), { jsonrpc: '2.0', id: 42, error: { code: -32000, message: 'Timed out', data: { hcsError: error } } });
    const second = hcsError('plugin_failed', 'Plugin failed');
    h.library.booksFor = () => { throw new HcsFailure([error, second]); };
    const multiple = await fetch(`${h.base}/review/api/books`, { headers: { authorization: `Bearer ${await h.session()}` } });
    assert.deepEqual((await multiple.json())['x-rewrite-errors'], [error, second]);
  } finally { h.library.booksFor = original; }
});

test('health is public and says nothing else', async () => {
  const res = await fetch(`${h.base}/health`);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { status: 'ok' });
});

test('health answers a container check that arrives by address, with any Host', async () => {
  const { request } = await import('node:http');
  const url = new URL(h.base);
  const status = await new Promise<number>((resolve, reject) => {
    const req = request({ host: url.hostname, port: url.port, path: '/health', headers: { host: '10.0.0.5:8080' } }, (r) => {
      r.resume();
      resolve(r.statusCode!);
    });
    req.on('error', reject);
    req.end();
  });
  assert.equal(status, 200);
});

test('protected resource metadata points to the issuer at both locations', async () => {
  for (const path of ['/.well-known/oauth-protected-resource/mcp', '/.well-known/oauth-protected-resource']) {
    const res = await fetch(h.base + path);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), {
      resource: h.resource,
      authorization_servers: [h.issuer],
      bearer_methods_supported: ['header'],
    });
  }
});

test('no token gets 401 with a challenge that points to the metadata', async () => {
  const res = await post();
  assert.equal(res.status, 401);
  const challenge = res.headers.get('www-authenticate')!;
  assert.match(challenge, /^Bearer /);
  assert.ok(challenge.includes(`${h.base}/.well-known/oauth-protected-resource/mcp`));
  assert.doesNotMatch(challenge, /invalid_token/);
});

test('a valid access token opens a real MCP session, and it sees only its books', async () => {
  const token = await h.access();
  const client = new Client({ name: 't', version: '1' });
  await client.connect(new StreamableHTTPClientTransport(new URL(h.resource), {
    requestInit: { headers: { authorization: `Bearer ${token}` } },
  }));
  const result: any = await client.callTool({ name: 'list_books', arguments: {} });
  assert.deepEqual(JSON.parse(result.content[0].text).books, [{ book_id: 'sal', title: 'La puerta de Sal' }]);
  await client.close();
});

test('a valid token from someone without books gets in but sees nothing', async () => {
  const client = new Client({ name: 't', version: '1' });
  await client.connect(new StreamableHTTPClientTransport(new URL(h.resource), {
    requestInit: { headers: { authorization: `Bearer ${await h.access('user_other')}` } },
  }));
  const result: any = await client.callTool({ name: 'list_books', arguments: {} });
  assert.deepEqual(JSON.parse(result.content[0].text).books, []);
  await client.close();
});

test('every kind of bad token is refused with invalid_token', async () => {
  const now = Math.floor(Date.now() / 1000);
  const bad: Record<string, string> = {
    garbage: 'not-a-token',
    'wrong signature': await h.sign({ iss: h.issuer, aud: h.resource, sub: 'user_fran' }, { key: h.strangerKey }),
    'wrong issuer': await h.access('user_fran', { iss: 'https://evil.example' }),
    'wrong audience': await h.access('user_fran', { aud: 'https://other.example/mcp' }),
    'no audience': await h.sign({ iss: h.issuer, sub: 'user_fran' }),
    expired: await h.sign({ iss: h.issuer, aud: h.resource, sub: 'user_fran' }, { expires: new Date((now - 3600) * 1000) }),
    'no subject': await h.sign({ iss: h.issuer, aud: h.resource }),
    'unknown key': await h.sign({ iss: h.issuer, aud: h.resource, sub: 'user_fran' }, { kid: 'other' }),
    'alg none': `${base64url.encode('{"alg":"none"}')}.${base64url.encode(JSON.stringify({ iss: h.issuer, aud: h.resource, sub: 'user_fran', exp: now + 300 }))}.`,
    'symmetric alg': await new SignJWT({ iss: h.issuer, aud: h.resource, sub: 'user_fran' })
      .setProtectedHeader({ alg: 'HS256' }).setExpirationTime('5m').sign(await generateSecret('HS256')),
  };
  for (const [name, token] of Object.entries(bad)) {
    const res = await post(token);
    assert.equal(res.status, 401, name);
    assert.match(res.headers.get('www-authenticate')!, /invalid_token/, name);
  }
});

test('a browser session token cannot open the MCP', async () => {
  const res = await post(await h.session());
  assert.equal(res.status, 401);
});

test('a token in the query string is ignored', async () => {
  const res = await fetch(`${h.resource}?access_token=${await h.access()}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(INIT),
  });
  assert.equal(res.status, 401);
});

test('a wrong Host header is refused before anything else', async () => {
  const res = await new Promise<number>((resolve, reject) => {
    const url = new URL(h.resource);
    import('node:http').then(({ request }) => {
      const req = request({ host: url.hostname, port: url.port, path: url.pathname, method: 'POST', headers: { host: 'evil.example' } }, (r) => {
        r.resume();
        resolve(r.statusCode!);
      });
      req.on('error', reject);
      req.end('{}');
    });
  });
  assert.equal(res, 403);
});

test('an oversized body gets 413 and malformed JSON gets 400, after authentication', async () => {
  const token = await h.access();
  assert.equal((await post(undefined, 'x'.repeat(2_000_000))).status, 401);
  assert.equal((await post(token, 'x'.repeat(2_000_000))).status, 413);
  assert.equal((await post(token, '{not json')).status, 400);
});

test('an unknown route gets 404', async () => {
  assert.equal((await fetch(`${h.base}/nope`)).status, 404);
});

test('GET and DELETE on the MCP answer 405, so no stream stays open', async () => {
  const headers = { authorization: `Bearer ${await h.access()}`, accept: 'text/event-stream' };
  assert.equal((await fetch(h.resource, { headers })).status, 405);
  assert.equal((await fetch(h.resource, { method: 'DELETE', headers })).status, 405);
});

test('an unparsable request target is a 400, not a server error', async () => {
  const { request } = await import('node:http');
  const url = new URL(h.base);
  const status = await new Promise<number>((resolve, reject) => {
    const req = request({ host: url.hostname, port: url.port, path: '//' }, (r) => {
      r.resume();
      resolve(r.statusCode!);
    });
    req.on('error', reject);
    req.end();
  });
  assert.ok(status === 400 || status === 404, `got ${status}`);
});

test('signing keys are cached, so many requests do not each hit the provider', async () => {
  const before = h.jwksHits();
  const token = await h.access();
  for (let i = 0; i < 5; i += 1) await post(token);
  assert.ok(h.jwksHits() - before <= 1, `fetched keys ${h.jwksHits() - before} times`);
});

test('invented key ids cannot make the server hammer the provider', async () => {
  const before = h.jwksHits();
  for (let i = 0; i < 10; i += 1) {
    await post(await h.sign({ iss: h.issuer, aud: h.resource, sub: 'x' }, { kid: `invented-${i}` }));
  }
  assert.ok(h.jwksHits() - before <= 1, `fetched keys ${h.jwksHits() - before} times`);
});

test('signing keys are not accepted from a redirect', async () => {
  const redirecting = createServer((req, res) => {
    res.statusCode = 302;
    res.setHeader('location', `${h.issuer}/.well-known/jwks.json`);
    res.end();
  });
  await new Promise<void>((resolve) => redirecting.listen(0, '127.0.0.1', resolve));
  const { port } = redirecting.address() as { port: number };
  const issuer = `http://127.0.0.1:${port}`;
  const { TokenVerifier } = await import('../src/adapters/auth.ts');
  const verifier = new TokenVerifier({ issuer, resource: h.resource, reviewOrigin: h.base });
  const token = await h.sign({ iss: issuer, aud: h.resource, sub: 'user_fran' });
  await assert.rejects(verifier.verifyAccessToken(token));
  redirecting.closeAllConnections();
  redirecting.close();
});

test('the server refuses to start without its settings, and has no way to turn auth off', () => {
  const full = {
    MCP_OAUTH_ISSUER: 'https://clerk.example.com',
    MCP_OAUTH_RESOURCE: 'https://rewrite.example.com/mcp',
    CLERK_PUBLISHABLE_KEY: 'pk_live_x',
    REWRITE_DATA_DIR: '/data',
  };
  assert.equal(readConfig(full).config.issuer, 'https://clerk.example.com');
  assert.equal(readConfig(full).config.reviewOrigin, 'https://rewrite.example.com');
  for (const name of Object.keys(full)) {
    const partial: Record<string, string> = { ...full };
    delete partial[name];
    assert.throws(() => readConfig(partial), new RegExp(name), name);
  }
  assert.throws(() => readConfig({ ...full, MCP_OAUTH_ISSUER: 'http://clerk.example.com' }), /https/);
  assert.throws(() => readConfig({ ...full, MCP_OAUTH_RESOURCE: 'http://rewrite.example.com/mcp' }), /https/);
  assert.equal(readConfig({ ...full, MCP_AUTH_DISABLED: '1' }).config.issuer, full.MCP_OAUTH_ISSUER);
});
