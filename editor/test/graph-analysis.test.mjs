import assert from 'node:assert/strict';
import { test } from 'node:test';
import { communities, components, orphans, ranking, shortestPath, suggestions, toGraph } from '../src/graph/analysis.js';

// Two triangles of notes joined by one link (a1 to b1), a note c that shares a2 and a3 with a1
// without ever meeting it, an orphan, and a scene that mentions c. Edges come as the review
// door's GET .../graph returns them (docs/notes-and-graph.md).
const note = (id, type = 'personaje') => ({ id: 'note:' + id, kind: 'note', name: id, label: id, type, degree: 0, scenes: 0 });
const edge = (kind, from, to, weight = 1) => ({ kind, from, to, weight });
const DATA = {
  nodes: [note('a1'), note('a2'), note('a3'), note('b1', 'lugar'), note('b2', 'lugar'), note('b3', 'lugar'), note('c', 'trama'), note('o', 'objeto'),
    { id: 'scene:scenes/001.md', kind: 'scene', name: 'scenes/001.md', label: '001', type: null, order: 1, degree: 1, scenes: null }],
  edges: [
    edge('cooccurs', 'note:a1', 'note:a2', 1), edge('cooccurs', 'note:a1', 'note:a3', 1), edge('cooccurs', 'note:a2', 'note:a3', 1),
    edge('cooccurs', 'note:b1', 'note:b2', 1), edge('cooccurs', 'note:b1', 'note:b3', 1), edge('cooccurs', 'note:b2', 'note:b3', 1),
    edge('link', 'note:a1', 'note:b1', 1), edge('cooccurs', 'note:a1', 'note:b1', 1),
    edge('cooccurs', 'note:a2', 'note:c', 1), edge('cooccurs', 'note:a3', 'note:c', 1),
    edge('mention', 'scene:scenes/001.md', 'note:c', 1),
    // An edge to a node that is not in the data (cut by a filter) is left out.
    edge('link', 'note:a1', 'note:gone', 1),
  ],
};

test('the graph merges the edges between two nodes into one, summing weights and keeping the co-occurrence weight', () => {
  const graph = toGraph(DATA);
  assert.equal(graph.order, 9);
  assert.equal(graph.size, 10);
  assert.deepEqual(graph.getEdgeAttributes(graph.edge('note:a1', 'note:b1')), { weight: 2, cooccurs: 1, kinds: ['cooccurs', 'link'] });
  assert.deepEqual(graph.getEdgeAttributes(graph.edge('scene:scenes/001.md', 'note:c')), { weight: 1, cooccurs: 0, kinds: ['mention'] });
  assert.equal(graph.hasNode('note:gone'), false);
  assert.equal(graph.getNodeAttribute('note:b1', 'type'), 'lugar');
});

test('rankings by degree, PageRank and betweenness list the top nodes with their values, ties by id', () => {
  const graph = toGraph(DATA);
  assert.deepEqual(ranking(graph, 'degree', 3), [{ id: 'note:a1', value: 3 }, { id: 'note:a2', value: 3 }, { id: 'note:a3', value: 3 }]);
  const pr = ranking(graph, 'pagerank', 20);
  assert.equal(pr.length, 9);
  assert.deepEqual(pr.slice(0, 2).map((row) => row.id).sort(), ['note:a1', 'note:b1'], 'the two ends of the bridge carry the most');
  assert.ok(Math.abs(pr.reduce((sum, row) => sum + row.value, 0) - 1) < 1e-6, 'PageRank sums to 1');
  const between = ranking(graph, 'betweenness', 2);
  assert.deepEqual(between.map((row) => row.id), ['note:a1', 'note:b1'], 'the go-betweens of the two groups');
  assert.ok(between[0].value > 0 && between[0].value <= 1, 'normalised');
  assert.equal(ranking(graph, 'betweenness', 20).find((row) => row.id === 'note:o').value, 0);
  assert.throws(() => ranking(graph, 'closeness', 3), /unknown metric/);
});

test('Louvain communities are stable across runs, largest first, with singletons counted apart', () => {
  const first = communities(toGraph(DATA));
  const again = communities(toGraph(DATA));
  assert.deepEqual(first, again);
  const groups = first.list.map((group) => [...group.members].sort());
  assert.equal(groups.length, 2);
  assert.equal(groups[0].length + groups[1].length, 8, 'every connected node in one of the two groups');
  assert.equal(first.of['note:b2'], first.of['note:b3']);
  assert.notEqual(first.of['note:a2'], first.of['note:b2']);
  assert.equal(first.list.every((group) => group.members.length >= 2), true);
  assert.equal(first.singletons, 1, 'the orphan');
  assert.equal(typeof first.of['note:o'], 'number', 'every node has a community, for its colour');
  assert.deepEqual(first.list.map((group) => group.index), first.list.map((_, i) => i));
});

test('the shortest path goes through the bridge, and there is none to an orphan or an unknown node', () => {
  const graph = toGraph(DATA);
  assert.deepEqual(shortestPath(graph, 'note:a2', 'note:b3'), ['note:a2', 'note:a1', 'note:b1', 'note:b3']);
  assert.deepEqual(shortestPath(graph, 'note:a2', 'note:a2'), ['note:a2']);
  assert.equal(shortestPath(graph, 'note:a2', 'note:o'), null);
  assert.equal(shortestPath(graph, 'note:a2', 'note:gone'), null);
});

test('components come largest first and orphans are the nodes with no edge at all', () => {
  const graph = toGraph(DATA);
  const parts = components(graph);
  assert.deepEqual(parts.map((part) => part.length), [8, 1]);
  assert.deepEqual(parts[1], ['note:o']);
  assert.deepEqual(orphans(graph), ['note:o']);
});

test('link suggestions are note pairs that share neighbours but never meet, best Adamic-Adar first', () => {
  const graph = toGraph(DATA);
  const list = suggestions(graph, 3);
  assert.equal(list.length, 3);
  assert.deepEqual(list[0], { a: 'note:a1', b: 'note:c', shared: 2, score: Number((2 / Math.log(3)).toFixed(4)) });
  for (const row of suggestions(graph, 50)) {
    assert.equal(graph.hasEdge(row.a, row.b), false, 'never a pair already joined');
    assert.ok(row.a < row.b);
    assert.equal(graph.getNodeAttribute(row.a, 'kind'), 'note');
    assert.equal(graph.getNodeAttribute(row.b, 'kind'), 'note');
    assert.notEqual(row.a, 'note:o');
  }
  assert.ok(suggestions(graph, 50).some((row) => row.a === 'note:a2' && row.b === 'note:b1'));
});
