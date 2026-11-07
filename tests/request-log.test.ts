import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { test } from 'node:test';
import { HcsFailure, hcsError } from '../src/hcs/errors.ts';
import { reviewApi, startHarness } from './server-helpers.ts';

const TYPE = 'https://github.com/FullFran/re-write/blob/main/docs/problems.md#';

for (const salted of [true, false]) test(`metadata request log protects manuscript privacy (${salted ? 'salted' : 'unset'})`, async (t) => {
  const oldSalt = process.env.REWRITE_LOG_SALT;
  if (salted) process.env.REWRITE_LOG_SALT = 'test-deployment-salt';
  else delete process.env.REWRITE_LOG_SALT;
  t.after(() => { if (oldSalt === undefined) delete process.env.REWRITE_LOG_SALT; else process.env.REWRITE_LOG_SALT = oldSalt; });
  const lines: string[] = [];
  const warnings: string[] = [];
  t.mock.method(console, 'log', (...args: unknown[]) => lines.push(args.join(' ')));
  t.mock.method(console, 'warn', (...args: unknown[]) => warnings.push(args.join(' ')));
  t.mock.method(console, 'error', (...args: unknown[]) => lines.push(args.join(' ')));
  const h = await startHarness();
  t.after(() => h.close());
  const subject = 'user_private_marker';
  const book = 'private-book-marker';
  const title = 'Private Title Marker';
  const file = 'private-scene-marker.md';
  const quote = 'Private quote marker from the manuscript.';
  const statement = 'Private statement marker';
  const token = await h.session(subject);
  const access = await h.access(subject);
  const responses: Response[] = [];
  const create = await reviewApi(h, '/books', token, { slug: book, title });
  responses.push(create);
  assert.equal(create.status, 201);
  const imported = await reviewApi(h, `/books/${book}/import`, token, { files: [{ name: file, content: quote }] });
  responses.push(imported);
  assert.equal(imported.status, 200);
  let id = 0;
  const rpc = async (method: string, params: object) => {
    const response = await fetch(h.resource, {
      method: 'POST',
      headers: { authorization: `Bearer ${access}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }),
    });
    responses.push(response);
    assert.equal(response.status, 200);
    return response.json() as Promise<any>;
  };
  assert.ok((await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: title, version: '1' } })).result);
  assert.ok((await rpc('tools/list', {})).result.tools.length);
  assert.equal((await rpc('tools/call', { name: 'read_scene', arguments: { book, file: `scenes/${file}` } })).result.isError, undefined);
  assert.equal((await rpc('tools/call', { name: 'propose_findings', arguments: { book, findings: [{ question: 'motivation', kind: 'fact', statement, evidence: [{ file: `scenes/${file}`, quote }] }] } })).result.isError, undefined);
  assert.equal((await rpc('tools/call', { name: 'read_scene', arguments: { book, file: `scenes/missing-${file}` } })).result.isError, true);
  assert.equal((await rpc('tools/call', { name: title, arguments: { book, quote } })).result.isError, true);
  const failure = hcsError('timeout', quote);
  h.library.booksFor = () => { throw new HcsFailure([failure]); };
  assert.equal((await rpc('tools/call', { name: 'list_books', arguments: {} })).error.data.hcsError.code, 'timeout');
  const failed = await reviewApi(h, '/books', token);
  responses.push(failed);
  assert.equal(failed.status, 504);
  h.library.booksFor = () => { throw new Error(quote); };
  const unexpected = await reviewApi(h, '/books', token);
  responses.push(unexpected);
  assert.equal(unexpected.status, 500);
  const denied = await reviewApi(h, `/books/${book}/scenes/${file}`);
  responses.push(denied);
  assert.equal(denied.status, 401);
  const missing = await fetch(`${h.base}/private-path-marker?title=${encodeURIComponent(title)}`);
  responses.push(missing);
  assert.equal(missing.status, 404);
  const health = await fetch(`${h.base}/health`, { headers: { 'x-request-id': title } });
  responses.push(health);
  assert.equal(health.status, 200);

  const ids = responses.map(r => r.headers.get('x-request-id'));
  assert.ok(ids.every(value => value && /^[0-9a-f-]{36}$/.test(value)), 'every HTTP response has a generated request id');
  assert.equal(new Set(ids).size, ids.length);
  const output = lines.join('\n');
  for (const marker of [subject, book, title, file, quote, statement, 'private-path-marker', access, token]) {
    assert.ok(!output.includes(marker), `must not log ${marker}`);
  }
  const records = lines.map(line => JSON.parse(line));
  const http = records.filter(r => r.event === 'http.request');
  const mcp = records.filter(r => r.event === 'mcp.call');
  assert.equal(http.length, responses.length);
  assert.equal(mcp.length, id);
  const hash = (value: string) => salted ? createHmac('sha256', 'test-deployment-salt').update(value).digest('hex').slice(0, 16) : 'unset';
  assert.ok(http.some(r => r.route === '/review/api/books/:book/import' && r.status === 200 && r.book === hash(book)));
  assert.ok(http.some(r => r.route === '/review/api/books/:book/scenes/:file' && r.status === 401 && r.subject === 'anon' && r.error === `${TYPE}unauthorized`));
  assert.ok(http.some(r => r.route === 'unmatched' && r.status === 404));
  assert.ok(http.some(r => r.status === 504 && r.error === 'timeout'));
  assert.ok(http.some(r => r.status === 500 && r.error === `${TYPE}internal-error`));
  assert.ok(mcp.some(r => r.method === 'initialize' && r.result === 'ok'));
  assert.ok(mcp.some(r => r.method === 'tools/list' && r.result === 'ok'));
  assert.ok(mcp.some(r => r.tool === 'read_scene' && r.result === 'ok' && r.book === hash(book)));
  assert.ok(mcp.some(r => r.tool === 'propose_findings' && r.result === 'ok'));
  assert.ok(mcp.some(r => r.tool === 'read_scene' && r.result === `${TYPE}invalid-input`));
  assert.ok(mcp.some(r => r.tool === 'unknown' && r.result === `${TYPE}invalid-input`));
  assert.ok(mcp.some(r => r.tool === 'list_books' && r.result === 'timeout'));
  for (const record of records) {
    assert.ok(Number.isFinite(record.duration_ms) && record.duration_ms >= 0);
    assert.ok(Number.isFinite(Date.parse(record.timestamp)));
    assert.ok(ids.includes(record.request_id));
    assert.ok(['mcp', 'review', 'public'].includes(record.door));
    assert.ok(['anon', hash(subject)].includes(record.subject));
    assert.deepEqual(Object.keys(record).filter(key => !['event', 'timestamp', 'request_id', 'method', 'route', 'status', 'duration_ms', 'door', 'subject', 'book', 'error', 'tool', 'result', 'reason', 'error_name'].includes(key)), []);
  }
  assert.equal(warnings.length, salted ? 0 : 1);
  if (!salted) assert.match(warnings[0], /REWRITE_LOG_SALT.*unset/);
});

test('rejected tokens retain only allowlisted diagnostic reasons, never token or message text', async (t) => {
  const lines: string[] = [];
  t.mock.method(console, 'log', (line: string) => lines.push(line));
  t.mock.method(console, 'error', (line: string) => lines.push(line));
  t.mock.method(console, 'warn', () => {});
  const h = await startHarness();
  t.after(() => h.close());
  const marker = 'private-auth-marker';
  const claims = { iss: h.issuer, aud: h.resource, sub: marker };
  const cases = [
    ['expired', await h.sign(claims, { expires: '-1h' })],
    ['audience', await h.sign({ ...claims, aud: marker })],
    ['issuer', await h.sign({ ...claims, iss: marker })],
    ['signature', await h.sign(claims, { key: h.strangerKey })],
    ['malformed', marker],
    ['other', ''],
  ];
  for (const [reason, token] of cases) {
    const response = await fetch(h.resource, { method: 'POST', headers: token ? { authorization: `Bearer ${token}` } : {} });
    assert.equal(response.status, 401);
    await response.text();
    const record = JSON.parse(lines.at(-1)!);
    assert.equal(record.reason, reason);
    assert.equal(record.subject, 'anon');
    assert.equal(record.error, `${TYPE}unauthorized`);
    if (token) assert.ok(!lines.join('\n').includes(token));
  }
  const session = await h.sign({ iss: h.issuer, sub: marker, sid: marker, azp: h.base }, { expires: '-1h' });
  assert.equal((await reviewApi(h, '/books', session)).status, 401);
  assert.equal(JSON.parse(lines.at(-1)!).reason, 'expired');
  assert.ok(!lines.join('\n').includes(marker));
});

test('unexpected HTTP 500 retains a sanitized Error subclass name, never its message', async (t) => {
  const lines: string[] = [];
  t.mock.method(console, 'log', (line: string) => lines.push(line));
  t.mock.method(console, 'error', (line: string) => lines.push(line));
  t.mock.method(console, 'warn', () => {});
  const h = await startHarness();
  t.after(() => h.close());
  const token = await h.session();
  const marker = 'Private manuscript message marker';
  for (const [error, name] of [[new TypeError(marker), 'TypeError'], [Object.assign(new Error(marker), { name: marker }), 'Error']] as const) {
    h.library.booksFor = () => { throw error; };
    const response = await reviewApi(h, '/books', token);
    assert.equal(response.status, 500);
    await response.text();
    const record = JSON.parse(lines.at(-1)!);
    assert.equal(record.error_name, name);
    assert.equal(record.error, `${TYPE}internal-error`);
    assert.ok(!lines.join('\n').includes(marker));
  }
});
