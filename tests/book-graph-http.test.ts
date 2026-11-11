import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { until } from './fixtures/engine/harness.ts';
import { git } from './helpers.ts';
import { reviewApi, startHarness, type Harness } from './server-helpers.ts';

// The graph as data for the review page (issue #115, slice 2): typed edges, degree, the scenes a
// note appears in, and the as_of_scene cut, read-only, through the review door.
let h: Harness;
let head: string;
before(async () => {
  h = await startHarness();
  mkdirSync(join(h.bookDir, 'notas'), { recursive: true });
  writeFileSync(join(h.bookDir, 'notas', 'Elena.md'), '---\ntype: personaje\naliases: [la capitana]\n---\nGuarda el [[Puerto]].\n');
  writeFileSync(join(h.bookDir, 'notas', 'Puerto.md'), '---\ntype: lugar\n---\nUn muelle.\n');
  writeFileSync(join(h.bookDir, 'notas', 'Brújula.md'), '---\ntype: objeto\n---\nNadie la nombra.\n');
  writeFileSync(join(h.bookDir, 'scenes', 'escena-01.md'), 'Llega [[la capitana]] al [[Puerto]].\n');
  writeFileSync(join(h.bookDir, 'scenes', 'escena-02.md'), '[[Elena]] y [[Puerto]] otra vez, con [[Elena]].\n');
  git(h.bookDir, 'add', 'notas', 'scenes');
  git(h.bookDir, '-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '-qm', 'notes');
  head = git(h.bookDir, 'rev-parse', 'HEAD');
});
after(() => h.close());

const node = (body: any, id: string) => body.nodes.find((n: any) => n.id === id);

test('a person reads the graph of a book: nodes with degree and scenes, and typed, weighted edges', async () => {
  const res = await reviewApi(h, '/books/sal/graph', await h.session());
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.as_of_scene, null);
  assert.deepEqual(body.scenes, ['scenes/escena-01.md', 'scenes/escena-02.md']);
  assert.deepEqual(body.nodes.map((n: any) => [n.id, n.kind, n.type, n.order, n.degree, n.scenes]), [
    ['note:Brújula', 'note', 'objeto', null, 0, 0],
    ['note:Elena', 'note', 'personaje', null, 3, 2],
    ['note:Puerto', 'note', 'lugar', null, 3, 2],
    ['scene:scenes/escena-01.md', 'scene', null, 1, 2, null],
    ['scene:scenes/escena-02.md', 'scene', null, 2, 2, null],
  ]);
  assert.deepEqual(body.edges, [
    { kind: 'cooccurs', from: 'note:Elena', to: 'note:Puerto', weight: 2 },
    { kind: 'link', from: 'note:Elena', to: 'note:Puerto', weight: 1 },
    { kind: 'mention', from: 'scene:scenes/escena-01.md', to: 'note:Elena', weight: 1 },
    { kind: 'mention', from: 'scene:scenes/escena-01.md', to: 'note:Puerto', weight: 1 },
    { kind: 'mention', from: 'scene:scenes/escena-02.md', to: 'note:Elena', weight: 2 },
    { kind: 'mention', from: 'scene:scenes/escena-02.md', to: 'note:Puerto', weight: 1 },
  ]);
  assert.deepEqual(body.too_large, []);
  assert.equal(git(h.bookDir, 'rev-parse', 'HEAD'), head, 'reading writes nothing');
  assert.equal(git(h.bookDir, 'status', '--porcelain'), '');
});

test('as_of_scene keeps the scenes up to that one and the edges they bring; notes and links stay', async () => {
  const res = await reviewApi(h, '/books/sal/graph?as_of_scene=' + encodeURIComponent('scenes/escena-01.md'), await h.session());
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.as_of_scene, 'scenes/escena-01.md');
  assert.deepEqual(body.scenes, ['scenes/escena-01.md', 'scenes/escena-02.md'], 'every scene stays listed for the slider');
  assert.equal(node(body, 'scene:scenes/escena-02.md'), undefined);
  assert.deepEqual([node(body, 'note:Elena').degree, node(body, 'note:Elena').scenes], [2, 1]);
  assert.deepEqual(body.edges.find((e: any) => e.kind === 'cooccurs'), { kind: 'cooccurs', from: 'note:Elena', to: 'note:Puerto', weight: 1 });
  assert.ok(body.edges.some((e: any) => e.kind === 'link'));
  assert.ok(!body.edges.some((e: any) => e.from === 'scene:scenes/escena-02.md'));
});

test('an unknown as_of_scene is a 400 that names the problem; only members read the graph', async () => {
  const session = await h.session();
  const bad = await reviewApi(h, '/books/sal/graph?as_of_scene=scenes%2Fnada.md', session);
  assert.equal(bad.status, 400);
  assert.match((await bad.json()).error, /unknown scene/);
  assert.equal((await reviewApi(h, '/books/sal/graph')).status, 401);
  assert.equal((await reviewApi(h, '/books/sal/graph', await h.session('user_stranger'))).status, 404);
  assert.equal((await reviewApi(h, '/books/sal/graph', session, {})).status, 404, 'there is no write');
});

test('the graph route is logged under its own route name, without the query', async (t) => {
  const lines: string[] = [];
  t.mock.method(console, 'log', (...args: unknown[]) => lines.push(args.join(' ')));
  t.mock.method(console, 'warn', () => {});
  t.mock.method(console, 'error', (...args: unknown[]) => lines.push(args.join(' ')));
  const logged = await startHarness();
  t.after(() => logged.close());
  await reviewApi(logged, '/books/sal/graph?as_of_scene=' + encodeURIComponent('scenes/escena-01.md'), await logged.session());
  await until(() => lines.some((line) => line.includes('"http.request"')));
  const routes = lines.map((line) => JSON.parse(line)).filter((r) => r.event === 'http.request').map((r) => r.route);
  assert.deepEqual(routes, ['/review/api/books/:book/graph']);
});
