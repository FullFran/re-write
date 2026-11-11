import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  analyseBook, backlinks, buildGraph, central, components, neighbors, NoteIndex, orphans, shortestPath, type BookText,
} from '../src/domain/story-graph.ts';

const note = (name: string, text: string) => ({ name, text });
const scene = (file: string, text: string) => ({ file, text });

test('resolution folds case and accents, prefers a note name to an alias, and never guesses between aliases', () => {
  const index = new NoteIndex([
    { name: 'Elena', aliases: ['la capitana', 'Capi'] },
    { name: 'Ángel', aliases: ['Capi'] },
    { name: 'Puente', aliases: ['elena'] },
  ]);
  assert.deepEqual(index.resolve('  ELENA '), { status: 'resolved', note: 'Elena' });
  assert.deepEqual(index.resolve('angel'), { status: 'resolved', note: 'Ángel' });
  assert.deepEqual(index.resolve('La Capitana'), { status: 'resolved', note: 'Elena' });
  assert.deepEqual(index.resolve('capi'), { status: 'ambiguous', candidates: ['Elena', 'Ángel'] });
  assert.deepEqual(index.resolve('Nadie'), { status: 'unresolved' });
  assert.deepEqual(new NoteIndex([{ name: 'Sal', aliases: [] }, { name: 'sal', aliases: [] }]).resolve('SAL'), { status: 'ambiguous', candidates: ['Sal', 'sal'] });
});

const book: BookText = {
  notes: [
    note('Elena', '---\ntype: personaje\naliases: [la capitana]\n---\nCustodia el [[Puente de Sal]]. Elena no duerme.'),
    note('Puente de Sal', '---\ntype: lugar\n---\nLo guarda [[Elena|su guardiana]] y lo cruza [[Tomás]].'),
    note('Tomás', 'Un viajero.'),
    note('Carta', '---\ntype: objeto\n---\nNadie la ha leído.'),
  ],
  scenes: [
    scene('scenes/001-a.md', 'Llovía. La capitana miró el río. Luego [[Elena]] cruzó el [[Puente de Sal#Historia|puente]] con [[Nadie]].\n`Elena` en código.'),
    scene('scenes/002-b.md', 'Tomás habló con [[Elena]]; elena no respondió, y Elenita tampoco.'),
    scene('scenes/003-c.md', '[[Tomás]] y [[Puente de Sal]] al alba. [[Tomás]] otra vez.'),
  ],
};

test('backlinks: linked mentions with their sentence, and unlinked mentions of the name or an alias as whole words', () => {
  const analysis = analyseBook(book);
  const elena = backlinks(analysis, 'Elena');
  assert.deepEqual(elena.linked.map(({ source, line, column, raw, context }) => ({ source, line, column, raw, context })), [
    { source: 'Puente de Sal', line: 4, column: 11, raw: '[[Elena|su guardiana]]', context: 'Lo guarda [[Elena|su guardiana]] y lo cruza [[Tomás]].' },
    { source: 'scenes/001-a.md', line: 1, column: 40, raw: '[[Elena]]', context: 'Luego [[Elena]] cruzó el [[Puente de Sal#Historia|puente]] con [[Nadie]].' },
    { source: 'scenes/002-b.md', line: 1, column: 17, raw: '[[Elena]]', context: 'Tomás habló con [[Elena]]; elena no respondió, y Elenita tampoco.' },
  ]);
  assert.deepEqual(elena.unlinked.map(({ source, text, line, column }) => ({ source, text, line, column })), [
    { source: 'scenes/001-a.md', text: 'La capitana', line: 1, column: 9 },
    { source: 'scenes/002-b.md', text: 'elena', line: 1, column: 28 },
  ], 'not inside links, code, its own note, or a longer word');
  assert.equal(elena.unlinked[0].context, 'La capitana miró el río.');
});

test('a long sentence is cut around the mention', () => {
  const long = `${'palabra '.repeat(60)}[[Elena]] ${'otra '.repeat(60)}.`;
  const { context } = backlinks(analyseBook({ notes: [note('Elena', '')], scenes: [scene('scenes/x.md', long)] }), 'Elena').linked[0];
  assert.ok(context.length <= 242, String(context.length));
  assert.match(context, /^….*\[\[Elena\]\].*…$/);
});

test('unresolved and ambiguous links are listed with where they are', () => {
  const analysis = analyseBook({ notes: [note('A', '---\naliases: [X]\n---\n'), note('B', '---\naliases: [x]\n---\n')], scenes: [scene('scenes/1.md', '[[x]] [[Nadie]] [[nadie]]')] });
  assert.deepEqual(analysis.unresolved.map(({ target, source, column }) => ({ target, source, column })), [
    { target: 'Nadie', source: 'scenes/1.md', column: 7 }, { target: 'nadie', source: 'scenes/1.md', column: 17 },
  ]);
  assert.deepEqual(analysis.ambiguous.map(({ target, candidates }) => ({ target, candidates })), [{ target: 'x', candidates: ['A', 'B'] }]);
});

test('the graph has typed edges in a deterministic order, and as_of_scene cuts scenes after it', () => {
  const graph = buildGraph(analyseBook(book));
  assert.deepEqual(graph.nodes.map((node) => node.id), [
    'note:Carta', 'note:Elena', 'note:Puente de Sal', 'note:Tomás', 'scene:scenes/001-a.md', 'scene:scenes/002-b.md', 'scene:scenes/003-c.md',
  ]);
  assert.deepEqual(graph.nodes.find((node) => node.id === 'note:Elena'), { id: 'note:Elena', kind: 'note', name: 'Elena', type: 'personaje', order: null });
  assert.deepEqual(graph.edges, [
    { kind: 'cooccurs', from: 'note:Elena', to: 'note:Puente de Sal', weight: 1 },
    { kind: 'cooccurs', from: 'note:Puente de Sal', to: 'note:Tomás', weight: 1 },
    { kind: 'link', from: 'note:Elena', to: 'note:Puente de Sal', weight: 1 },
    { kind: 'link', from: 'note:Puente de Sal', to: 'note:Elena', weight: 1 },
    { kind: 'link', from: 'note:Puente de Sal', to: 'note:Tomás', weight: 1 },
    { kind: 'mention', from: 'scene:scenes/001-a.md', to: 'note:Elena', weight: 1 },
    { kind: 'mention', from: 'scene:scenes/001-a.md', to: 'note:Puente de Sal', weight: 1 },
    { kind: 'mention', from: 'scene:scenes/002-b.md', to: 'note:Elena', weight: 1 },
    { kind: 'mention', from: 'scene:scenes/003-c.md', to: 'note:Puente de Sal', weight: 1 },
    { kind: 'mention', from: 'scene:scenes/003-c.md', to: 'note:Tomás', weight: 2 },
  ]);
  const early = buildGraph(analyseBook(book), 'scenes/002-b.md');
  assert.deepEqual(early.nodes.filter((node) => node.kind === 'scene').map((node) => node.id), ['scene:scenes/001-a.md', 'scene:scenes/002-b.md']);
  assert.equal(early.edges.some((edge) => edge.from === 'scene:scenes/003-c.md' || edge.kind === 'cooccurs' && edge.to === 'note:Tomás'), false);
  assert.equal(early.edges.filter((edge) => edge.kind === 'link').length, 3, 'notes and their links are always kept');
  assert.throws(() => buildGraph(analyseBook(book), 'scenes/999.md'), /unknown scene: scenes\/999.md/);
});

test('cooccurs weight counts the scenes two notes share', () => {
  const graph = buildGraph(analyseBook({
    notes: [note('A', ''), note('B', '')],
    scenes: [scene('scenes/1.md', '[[A]] [[B]] [[A]]'), scene('scenes/2.md', '[[B]] [[A]]'), scene('scenes/3.md', '[[A]]')],
  }));
  assert.deepEqual(graph.edges.filter((edge) => edge.kind === 'cooccurs'), [{ kind: 'cooccurs', from: 'note:A', to: 'note:B', weight: 2 }]);
});

test('graph operations: neighbours at depth k, shortest path, degree ranking, components and orphans', () => {
  const graph = buildGraph(analyseBook(book));
  assert.deepEqual(neighbors(graph, 'note:Tomás', 1).nodes.map(({ id, distance }) => [id, distance]), [
    ['note:Tomás', 0], ['note:Puente de Sal', 1], ['scene:scenes/003-c.md', 1],
  ]);
  const two = neighbors(graph, 'note:Tomás', 2);
  assert.deepEqual(two.nodes.map(({ id, distance }) => [id, distance]), [
    ['note:Tomás', 0], ['note:Puente de Sal', 1], ['scene:scenes/003-c.md', 1], ['note:Elena', 2], ['scene:scenes/001-a.md', 2],
  ]);
  assert.ok(two.edges.every((edge) => two.nodes.some((n) => n.id === edge.from) && two.nodes.some((n) => n.id === edge.to)));
  assert.deepEqual(shortestPath(graph, 'scene:scenes/002-b.md', 'note:Tomás'), ['scene:scenes/002-b.md', 'note:Elena', 'note:Puente de Sal', 'note:Tomás']);
  assert.equal(shortestPath(graph, 'note:Carta', 'note:Elena'), null);
  assert.deepEqual(shortestPath(graph, 'note:Carta', 'note:Carta'), ['note:Carta']);
  assert.deepEqual(central(graph, 'note').map(({ id, degree }) => [id, degree]), [
    ['note:Puente de Sal', 4], ['note:Elena', 3], ['note:Tomás', 2], ['note:Carta', 0],
  ]);
  assert.deepEqual(components(graph).map((c) => c.length), [6, 1]);
  assert.deepEqual(components(graph)[1], ['note:Carta']);
  assert.deepEqual(orphans(graph).map((node) => node.id), ['note:Carta']);
  assert.throws(() => neighbors(graph, 'note:Nadie', 1), /unknown node: note:Nadie/);
});
