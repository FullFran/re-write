import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  analyseBook, betweenness, buildGraph, GraphTooLargeError, knowsEdges, linkAnchors, MAX_SUGGEST_WORK, pageRank, suggestionCost, suggestLinks,
  type KnowledgeClaim, type StoryGraph,
} from '../src/domain/story-graph.ts';

// Issue #115, slice 4: who-knows-what edges, the paragraph co-occurrence weight, PageRank,
// betweenness and link suggestions.

const note = (name: string, text = '') => ({ name, text });
const scene = (file: string, text: string) => ({ file, text });

/** A graph given by its edges; every node named in them is a note unless its id starts with scene:. */
function graphOf(edges: [kind: 'mention' | 'link' | 'cooccurs', from: string, to: string][]): StoryGraph {
  const ids = [...new Set(edges.flatMap(([, from, to]) => [from, to]))].sort();
  return {
    nodes: ids.map((id) => ({ id, kind: id.startsWith('scene:') ? 'scene' as const : 'note' as const, name: id.slice(id.indexOf(':') + 1), type: null, order: null })),
    edges: edges.map(([kind, from, to]) => ({ kind, from, to, weight: 1 })),
  };
}

test('paragraph co-occurrence: a second weight counts the paragraphs two notes share; blank lines (also CRLF and spaces) separate paragraphs', () => {
  const analysis = analyseBook({
    notes: [note('A'), note('B'), note('C')],
    scenes: [
      scene('scenes/1.md', '[[A]] y [[B]].\n\n[[C]] solo.\n   \n[[A]] con [[C]].'),
      scene('scenes/2.md', '[[A]]\n[[B]]'),
      scene('scenes/3.md', '[[B]]\r\n\r\n[[C]]'),
    ],
  });
  const cooccurs = buildGraph(analysis, undefined, { paragraphs: true }).edges.filter((edge) => edge.kind === 'cooccurs');
  assert.deepEqual(cooccurs, [
    { kind: 'cooccurs', from: 'note:A', to: 'note:B', weight: 2, paragraphs: 2 },
    { kind: 'cooccurs', from: 'note:A', to: 'note:C', weight: 1, paragraphs: 1 },
    { kind: 'cooccurs', from: 'note:B', to: 'note:C', weight: 2, paragraphs: 0 },
  ]);
  const cut = buildGraph(analysis, 'scenes/1.md', { paragraphs: true }).edges.filter((edge) => edge.kind === 'cooccurs');
  assert.deepEqual(cut.map((edge) => [edge.from, edge.to, edge.weight, edge.paragraphs]), [
    ['note:A', 'note:B', 1, 1], ['note:A', 'note:C', 1, 1], ['note:B', 'note:C', 1, 0],
  ]);
});

test('without the paragraph option the edges are exactly as before: no paragraphs field', () => {
  const analysis = analyseBook({ notes: [note('A'), note('B')], scenes: [scene('scenes/1.md', '[[A]]\n\n[[B]]')] });
  assert.deepEqual(buildGraph(analysis).edges, [
    { kind: 'cooccurs', from: 'note:A', to: 'note:B', weight: 1 },
    { kind: 'mention', from: 'scene:scenes/1.md', to: 'note:A', weight: 1 },
    { kind: 'mention', from: 'scene:scenes/1.md', to: 'note:B', weight: 1 },
  ]);
});

const knowsBook = analyseBook({
  notes: [
    note('Elena', '---\naliases: [la capitana]\n---\n'),
    note('Tomás'), note('Carta'),
    note('Puente', '---\naliases: [capi]\n---\n'),
    note('Faro', '---\naliases: [capi]\n---\n'),
  ],
  scenes: [scene('scenes/1.md', ''), scene('scenes/2.md', ''), scene('scenes/3.md', '')],
});
const claim = (claim_id: string, source_file: string, subject: string, holder: string | null, mode: 'displays' | 'acquires' | 'hears', editorial_status = 'proposed', story_time?: number): KnowledgeClaim => ({
  claim_id, source_file, subject, editorial_status, ...(story_time === undefined ? {} : { story_time }),
  ...(holder === null ? {} : { knowledge: { holder, fact: `fact-${claim_id}`, mode } }),
});
const claims: KnowledgeClaim[] = [
  claim('C-2', 'scenes/3.md', 'Tomás', 'Elena', 'hears', 'accepted'),
  claim('C-1', 'scenes/1.md', 'Carta', 'la capitana', 'acquires', 'proposed', 3),
  claim('C-3', 'scenes/2.md', 'El tesoro', 'Tomás', 'displays'),
  claim('C-4', 'scenes/2.md', 'Carta', 'capi', 'displays'),
  claim('C-5', 'scenes/1.md', 'Tomás', 'Elena', 'acquires', 'rejected'),
  claim('C-6', 'scenes/1.md', 'Carta', null, 'displays'),
  claim('C-7', 'scenes/999.md', 'Carta', 'Elena', 'displays'),
];

test('knows edges: holder note to subject note, with mode, fact and the scene that establishes it; names resolve like links and are reported, never guessed', () => {
  const knows = knowsEdges(knowsBook, claims);
  assert.deepEqual(knows.edges, [
    { kind: 'knows', from: 'note:Elena', to: 'note:Carta', mode: 'acquires', fact: 'fact-C-1', scene: 'scenes/1.md', claim_id: 'C-1', story_time: 3, editorial_status: 'proposed' },
    { kind: 'knows', from: 'note:Elena', to: 'note:Tomás', mode: 'hears', fact: 'fact-C-2', scene: 'scenes/3.md', claim_id: 'C-2', story_time: null, editorial_status: 'accepted' },
  ]);
  assert.deepEqual(knows.unresolved, [{ claim_id: 'C-3', role: 'subject', name: 'El tesoro', scene: 'scenes/2.md' }]);
  assert.deepEqual(knows.ambiguous, [{ claim_id: 'C-4', role: 'holder', name: 'capi', scene: 'scenes/2.md', candidates: ['Faro', 'Puente'] }]);
});

test('knows edges respect as_of_scene: only knowledge established at or before that scene, and later problems stay hidden too', () => {
  const knows = knowsEdges(knowsBook, claims, 'scenes/1.md');
  assert.deepEqual(knows.edges.map((edge) => edge.claim_id), ['C-1']);
  assert.deepEqual(knows.unresolved, []);
  assert.deepEqual(knows.ambiguous, []);
  assert.deepEqual(knowsEdges(knowsBook, claims, 'scenes/2.md').edges.map((edge) => edge.claim_id), ['C-1']);
  assert.throws(() => knowsEdges(knowsBook, claims, 'scenes/9.md'), /unknown scene: scenes\/9.md/);
});

test('PageRank follows link and mention direction (co-occurrence both ways), redistributes dangling mass, and is rounded and deterministic', () => {
  const two = pageRank(graphOf([['link', 'note:A', 'note:B']]));
  assert.deepEqual([...two], [['note:A', 0.350877], ['note:B', 0.649123]]);
  const cycle = pageRank(graphOf([['link', 'note:A', 'note:B'], ['link', 'note:B', 'note:C'], ['link', 'note:C', 'note:A']]));
  assert.deepEqual([...cycle.values()], [0.333333, 0.333333, 0.333333]);
  const both = pageRank(graphOf([['cooccurs', 'note:A', 'note:B']]));
  assert.deepEqual([...both.values()], [0.5, 0.5]);
});

test('betweenness (Brandes) counts the shortest paths through each node, edges taken in both directions', () => {
  assert.deepEqual([...betweenness(graphOf([['link', 'note:A', 'note:B'], ['link', 'note:C', 'note:B']]))], [['note:A', 0], ['note:B', 1], ['note:C', 0]]);
  const star = betweenness(graphOf([['mention', 'scene:s', 'note:A'], ['mention', 'scene:s', 'note:B'], ['mention', 'scene:s', 'note:C']]));
  assert.equal(star.get('scene:s'), 3);
  // Two equal shortest paths A-B-D and A-C-D share the credit.
  const square = betweenness(graphOf([['link', 'note:A', 'note:B'], ['link', 'note:A', 'note:C'], ['link', 'note:B', 'note:D'], ['link', 'note:C', 'note:D']]));
  assert.deepEqual([...square.values()], [0.5, 0.5, 0.5, 0.5]);
});

const suggestGraph = graphOf([
  ['mention', 'scene:s1', 'note:A'], ['mention', 'scene:s1', 'note:B'], ['mention', 'scene:s1', 'note:C'],
  ['mention', 'scene:s2', 'note:A'], ['mention', 'scene:s2', 'note:B'],
  ['mention', 'scene:s3', 'note:B'], ['mention', 'scene:s3', 'note:C'],
  ['link', 'note:A', 'note:B'], ['link', 'note:D', 'note:C'],
]);

test('link suggestions by Adamic-Adar rank note pairs by shared neighbours, rarest first, and leave out pairs already linked', () => {
  assert.deepEqual(suggestLinks(suggestGraph, { metric: 'adamic_adar', top: 10 }), [
    { from: 'note:B', to: 'note:C', score: 2.352934, common: 2, via: ['scene:s1', 'scene:s3'] },
    { from: 'note:A', to: 'note:C', score: 0.910239, common: 1, via: ['scene:s1'] },
  ]);
  assert.deepEqual(suggestLinks(suggestGraph, { metric: 'adamic_adar', node: 'note:C', top: 1 }), [
    { from: 'note:C', to: 'note:B', score: 2.352934, common: 2, via: ['scene:s1', 'scene:s3'] },
  ]);
});

test('link suggestions by Jaccard divide shared neighbours by all neighbours of the pair', () => {
  assert.deepEqual(suggestLinks(suggestGraph, { metric: 'jaccard', top: 10 }).map((s) => [s.from, s.to, s.score]), [
    ['note:B', 'note:C', 0.4], ['note:A', 'note:C', 0.2],
  ]);
  assert.throws(() => suggestLinks(suggestGraph, { metric: 'jaccard', node: 'scene:s1', top: 5 }), /suggestions are between notes/);
});

test('betweenness and suggestions refuse a graph above the work cap instead of holding the server', () => {
  assert.throws(() => betweenness(suggestGraph, 10), (error: unknown) => error instanceof GraphTooLargeError && /too large for betweenness/.test(error.message));
  assert.throws(() => suggestLinks(suggestGraph, { metric: 'adamic_adar', top: 5 }, 3), (error: unknown) => error instanceof GraphTooLargeError && /too large for link suggestions/.test(error.message));
});

test('suggestions measure their cost before any work and refuse a dense graph at once', () => {
  // 300 notes linked from one scene: every pair co-occurs, every note has 300 neighbours.
  const names = Array.from({ length: 300 }, (_, i) => `note:N${String(i).padStart(3, '0')}`);
  const edges: [kind: 'mention' | 'cooccurs', from: string, to: string][] = names.map((id) => ['mention', 'scene:s', id]);
  for (let i = 0; i < names.length; i += 1) for (let j = i + 1; j < names.length; j += 1) edges.push(['cooccurs', names[i], names[j]]);
  const dense = graphOf(edges);
  assert.equal(suggestionCost(dense), 300 * 300 * 300, 'each note visits 300 neighbours of 300 neighbours each');
  assert.equal(suggestionCost(dense, names[0]), 300 * 300);
  assert.ok(suggestionCost(dense) > MAX_SUGGEST_WORK);
  const start = performance.now();
  assert.throws(() => suggestLinks(dense, { metric: 'adamic_adar', top: 10 }), (error: unknown) => error instanceof GraphTooLargeError && /too large for link suggestions/.test(error.message));
  const ms = performance.now() - start;
  assert.ok(ms < 100, `refused after ${Math.round(ms)} ms`);
  assert.equal(suggestLinks(dense, { metric: 'adamic_adar', node: names[0], top: 3 }).length, 3, 'one note of the same graph stays under the cap');
});

test('link anchors: plain-text mentions of one note in the other, with a find that is an exact, unique passage and its linked replacement', () => {
  const analysis = analyseBook({
    notes: [
      note('Elena', 'Cruza el puente con Tomás. Luego [[Tomás]] calla.'),
      note('Tomás', '---\naliases: [el viajero]\n---\nNo conoce a nadie.'),
      note('Ana', 'Habla con el viajero.'),
      note('Eco', 'Saluda a Tomás.\nSaluda a Tomás.\n'),
      note('Largo', `${'pasa '.repeat(60)}Tomás${' y pasa'.repeat(60)}.`),
    ],
    scenes: [],
  });
  assert.deepEqual(linkAnchors(analysis, 'Elena', 'Tomás'), { mentions: 1, unchecked: false, anchors: [
    { note: 'Elena', line: 1, column: 21, text: 'Tomás', context: 'Cruza el puente con Tomás.', find: 'Cruza el puente con Tomás.', replace: 'Cruza el puente con [[Tomás]].' },
  ] });
  assert.deepEqual(linkAnchors(analysis, 'Tomás', 'Elena'), { mentions: 0, unchecked: false, anchors: [] });
  assert.deepEqual(linkAnchors(analysis, 'Ana', 'Tomás').anchors.map((a) => [a.find, a.replace]), [['Habla con el viajero.', 'Habla con [[Tomás|el viajero]].']]);
  assert.deepEqual(linkAnchors(analysis, 'Eco', 'Tomás'), { mentions: 2, unchecked: false, anchors: [] }, 'a repeated passage is never offered');
  const long = linkAnchors(analysis, 'Largo', 'Tomás').anchors;
  assert.equal(long.length, 1);
  assert.ok(long[0].context.includes('…'), 'the context for reading is cut');
  assert.ok(!long[0].find.includes('…') && long[0].find.includes('Tomás') && long[0].find.length <= 240);
  const text = analysis.sources.find((s) => s.id === 'Largo')!.text;
  assert.equal(text.indexOf(long[0].find), text.lastIndexOf(long[0].find), 'the find is unique');
  assert.deepEqual(linkAnchors(analysis, 'Elena', 'Tomás', 3, { left: 5 }), { mentions: 0, unchecked: true, anchors: [] }, 'a spent budget checks nothing');
});
