import assert from 'node:assert/strict';
import { test } from 'node:test';
import { proposeRevision, startHarness } from './server-helpers.ts';

const BOOK = 'sal';
const SCENE = 'scenes/escena-01.md';
const OTHER_SCENE = 'scenes/escena-02.md';
const QUEUE_ROUTE = `/review/api/books/${BOOK}`;

test('the queue read is conditional, so polling it is cheap', async (t) => {
  t.mock.method(console, 'log', () => {});
  t.mock.method(console, 'warn', () => {});
  const h = await startHarness();
  t.after(() => h.close());
  const session = await h.session();
  const get = (headers: Record<string, string> = {}) =>
    fetch(`${h.base}${QUEUE_ROUTE}`, { headers: { authorization: `Bearer ${session}`, ...headers } });

  await t.test('a conditional read answers 304 with no body until the queue changes', async () => {
    const first = await get();
    const etag = first.headers.get('etag');
    assert.equal(first.status, 200);
    assert.match(etag ?? '', /^"[A-Za-z0-9_-]+"$/);
    await first.arrayBuffer();

    const unchanged = await get({ 'if-none-match': etag! });
    assert.equal(unchanged.status, 304);
    assert.equal(unchanged.headers.get('etag'), etag);
    assert.equal(unchanged.headers.get('cache-control'), 'no-store');
    assert.equal((await unchanged.arrayBuffer()).byteLength, 0);

    const id = proposeRevision(h.bookDir, OTHER_SCENE, 'una vela casi consumida', 'una vela nueva');
    const changed = await get({ 'if-none-match': etag! });
    assert.equal(changed.status, 200);
    assert.notEqual(changed.headers.get('etag'), etag);
    assert.ok((await changed.json()).proposals.some((p: any) => p.proposal.proposal_id === id));
  });

  await t.test('a plain read of the queue still returns the whole body, never cached', async () => {
    const response = await get();
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type') ?? '', /^application\/json/);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    const queue = await response.json();
    assert.deepEqual(Object.keys(queue).sort(), ['canon', 'claims', 'finding_views', 'findings', 'proposals', 'scenes']);
    assert.deepEqual(queue.scenes, [SCENE, OTHER_SCENE]);
    // A stale validator is not an error: the caller simply gets the current state.
    const stale = await get({ 'if-none-match': '"not-the-current-state"' });
    assert.equal(stale.status, 200);
    assert.deepEqual(await stale.json(), queue);
  });
});

