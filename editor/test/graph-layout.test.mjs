import assert from 'node:assert/strict';
import { test } from 'node:test';
import { layoutIterations, runLayout, seedPosition } from '../src/graph/layout.js';

test('a node starts where its id says, every time, inside the unit square', () => {
  const a = seedPosition('note:Elena');
  assert.deepEqual(seedPosition('note:Elena'), a);
  assert.notDeepEqual(seedPosition('note:Mar'), a);
  for (const id of ['note:Elena', 'note:Mar', 'scene:scenes/001.md', '']) {
    const { x, y } = seedPosition(id);
    assert.ok(Math.abs(x) <= 1 && Math.abs(y) <= 1, id);
  }
});

test('ForceAtlas2 is deterministic, keeps every position finite and pulls joined nodes closer than unjoined ones', () => {
  // Two pairs, joined inside each pair and not across.
  const ids = ['note:a', 'note:b', 'note:c', 'note:d'];
  const input = { nodes: ids.map((id) => ({ id, ...seedPosition(id) })), edges: [[0, 1, 3], [2, 3, 3]], iterations: 200 };
  const first = runLayout(input);
  assert.deepEqual(runLayout(input), first);
  assert.equal(first.length, 4);
  assert.ok(first.every(([x, y]) => Number.isFinite(x) && Number.isFinite(y)));
  const dist = (i, j) => Math.hypot(first[i][0] - first[j][0], first[i][1] - first[j][1]);
  assert.ok(dist(0, 1) < dist(0, 2) && dist(2, 3) < dist(1, 3));
});

test('a graph whose positions are mostly cached moves less than a fresh one, and an empty graph is no work', () => {
  assert.ok(layoutIterations(100, 0) > layoutIterations(100, 95));
  assert.ok(layoutIterations(2000, 0) <= layoutIterations(100, 0), 'large graphs take fewer iterations');
  assert.equal(layoutIterations(100, 100), 0, 'every position cached: nothing to lay out');
  assert.deepEqual(runLayout({ nodes: [], edges: [], iterations: 50 }), []);
});
