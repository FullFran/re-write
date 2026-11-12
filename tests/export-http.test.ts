import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { readZip } from '../src/adapters/zip.ts';
import { git } from './helpers.ts';
import { reviewApi, startHarness, type Harness } from './server-helpers.ts';

let h: Harness;
before(async () => {
  h = await startHarness();
});
after(() => h.close());

test('a member downloads the manuscript as Markdown, as an attachment with a safe name', async () => {
  const res = await reviewApi(h, '/books/sal/export?format=md', await h.session());
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type') ?? '', /^text\/markdown/);
  assert.match(res.headers.get('content-disposition') ?? '', /^attachment; filename="[A-Za-z0-9-]+\.md"$/);
  assert.equal(res.headers.get('cache-control'), 'no-store');
  const text = await res.text();
  assert.match(text, /^# /);
  assert.ok(text.length > 20);
});

test('a member downloads the manuscript as Word: a zip with the document part', async () => {
  const res = await reviewApi(h, '/books/sal/export?format=docx', await h.session());
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
  assert.match(res.headers.get('content-disposition') ?? '', /^attachment; filename="[A-Za-z0-9-]+\.docx"$/);
  const names = readZip(Buffer.from(await res.arrayBuffer())).map((e) => e.name);
  assert.ok(names.includes('word/document.xml'));
});

test('the manuscript export refuses strangers and anonymous callers, and an unknown format', async () => {
  assert.equal((await reviewApi(h, '/books/sal/export?format=md')).status, 401);
  assert.equal((await reviewApi(h, '/books/sal/export?format=md', await h.session('user_stranger'))).status, 404);
  assert.equal((await reviewApi(h, '/books/sal/export?format=pdf', await h.session())).status, 400);
  assert.equal((await reviewApi(h, '/books/sal/export?format=pdf', await h.session('user_stranger'))).status, 404);
});

test('without a format the same URL still answers with the findings JSON', async () => {
  const res = await reviewApi(h, '/books/sal/export', await h.session());
  assert.equal(res.status, 200);
  assert.ok(Array.isArray((await res.json()).findings));
});

test('exporting writes no commit and changes no book file', async () => {
  const before = git(h.bookDir, 'rev-list', '--all', '--count') + git(h.bookDir, 'status', '--porcelain');
  await reviewApi(h, '/books/sal/export?format=docx', await h.session());
  await reviewApi(h, '/books/sal/export?format=md', await h.session());
  assert.equal(git(h.bookDir, 'rev-list', '--all', '--count') + git(h.bookDir, 'status', '--porcelain'), before);
});
