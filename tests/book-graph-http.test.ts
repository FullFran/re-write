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

// Issue #115, slice 4: optional query parameters add metrics, knows edges, the paragraph weight and
// link suggestions; without them the answer keeps exactly its earlier fields.
test('without the new parameters the graph keeps exactly its earlier fields', async () => {
  const body = await (await reviewApi(h, '/books/sal/graph', await h.session())).json();
  assert.deepEqual(Object.keys(body), ['as_of_scene', 'scenes', 'nodes', 'edges', 'too_large']);
  assert.deepEqual(Object.keys(node(body, 'note:Elena')), ['id', 'kind', 'name', 'type', 'order', 'degree', 'scenes']);
  assert.ok(body.edges.every((e: any) => Object.keys(e).join() === 'kind,from,to,weight'));
});

test('metrics, include and suggest add PageRank, betweenness, knows edges, the paragraph weight and link suggestions', async () => {
  const query = '?metrics=pagerank,betweenness&include=knows,paragraphs&suggest=jaccard&top=2';
  const res = await reviewApi(h, '/books/sal/graph' + query, await h.session());
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.ok(body.nodes.every((n: any) => typeof n.pagerank === 'number' && typeof n.betweenness === 'number'));
  assert.equal(node(body, 'note:Brújula').betweenness, 0);
  assert.deepEqual(body.edges.find((e: any) => e.kind === 'cooccurs'), { kind: 'cooccurs', from: 'note:Elena', to: 'note:Puerto', weight: 2, paragraphs: 2 });
  assert.deepEqual(body.knows, { edges: [], unresolved: [], ambiguous: [] });
  assert.deepEqual(body.suggestions, { metric: 'jaccard', items: [] }, 'Elena and Puerto are already linked; Brújula shares nothing');
  assert.equal(git(h.bookDir, 'status', '--porcelain'), '');
});

test('an unknown metric, include, suggest or top value is a 400 that names it', async () => {
  const session = await h.session();
  for (const [query, pattern] of [
    ['metrics=closeness', /unknown metrics value: closeness/],
    ['include=everything', /unknown include value: everything/],
    ['suggest=magic', /unknown suggest value: magic/],
    ['suggest=adamic_adar,jaccard', /suggest takes one value: adamic_adar or jaccard/],
    ['suggest=jaccard&top=0', /top must be a whole number from 1 to 50/],
  ] as const) {
    const res = await reviewApi(h, `/books/sal/graph?${query}`, session);
    assert.equal(res.status, 400, query);
    assert.match((await res.json()).error, pattern);
  }
});
