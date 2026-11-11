import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  analyseBook, backlinks, betweenness, buildGraph, knowsEdges, MAX_ANALYSED_CHARS, MAX_GRAPH_WORK, MAX_SUGGEST_WORK, pageRank, suggestionCost, suggestLinks,
  type KnowledgeClaim, type StoryGraph,
} from '../src/domain/story-graph.ts';
import { codeRanges, parseWikilinks } from '../src/domain/wikilink.ts';

/**
 * One member's hostile text must not block the single-threaded server for everyone. Each case took
 * seconds or minutes at 1 MB when a pass was quadratic. By default the inputs are 64 KB, and growing
 * one four times must cost well under sixteen times as much (quadratic) time. With
 * REWRITE_SCALE_FULL=1 (run on a CI machine, never on a shared laptop) the inputs are 1 MB and each
 * must also finish within a second. Checks compare counts, never whole results, so a failure cannot
 * print a huge diff.
 */
const FULL = process.env.REWRITE_SCALE_FULL === '1';
const SIZE = FULL ? 1_000_000 : 65_536;
const BOUND_MS = 1000;
const MAX_RATIO = 8;

function fastest(run: () => unknown): number {
  let best = Infinity;
  for (let i = 0; i < 3; i += 1) {
    const start = performance.now();
    run();
    best = Math.min(best, performance.now() - start);
  }
  return best;
}

/** `make(size)` builds an input of about `size` characters; `run` processes it. */
function linear<T>(name: string, make: (size: number) => T, run: (input: T) => unknown): void {
  const small = make(SIZE / 4);
  const large = make(SIZE);
  run(small); // warm up the JIT
  const ratio = (fastest(() => run(large)) + 1) / (fastest(() => run(small)) + 1);
  assert.ok(ratio < MAX_RATIO, `${name}: four times the input took ${ratio.toFixed(1)} times as long`);
  if (FULL) {
    const start = performance.now();
    run(large);
    const ms = performance.now() - start;
    assert.ok(ms < BOUND_MS, `${name}: ${Math.round(ms)} ms on ${SIZE} characters`);
  }
}

const repeat = (unit: string) => (size: number) => unit.repeat(Math.floor(size / unit.length));
const elena = (scene: string) => analyseBook({ notes: [{ name: 'Elena', text: '' }], scenes: [{ file: 'scenes/1.md', text: scene }] });

test('a text made of "[[" parses in linear time', () => {
  linear('[[', repeat('[['), (text) => assert.equal(parseWikilinks(text).length, 0));
});

test('a text made of fence lines finds its code ranges in linear time', () => {
  linear('fences', repeat('```\n'), (text) => assert.equal(codeRanges(text).length, text.length / 8));
});

test('fences alternating with links parse in linear time, and links between fences still count', () => {
  linear('fences and links', repeat('```\n[[x]]\n'), (text) => assert.equal(parseWikilinks(text).length, Math.floor(text.length / 20)));
  linear('spans and links', repeat('a `b` [[x]] c\n'), (text) => assert.equal(parseWikilinks(text).length, text.length / 14));
});

test('backlinks over many lines of linked and unlinked mentions run in linear time', () => {
  linear('lines', repeat('[[Elena]] y Elena.\n'), (text) => {
    const found = backlinks(elena(text), 'Elena');
    assert.equal(found.linked_total, text.length / 19);
    assert.equal(found.unlinked_total, text.length / 19);
    assert.equal(found.unlinked.at(-1)!.context, '[[Elena]] y Elena.');
  });
});

test('one long line with many mentions finds each sentence once', () => {
  linear('long line', repeat('Elena '), (text) => {
    const found = backlinks(elena(text), 'Elena');
    assert.equal(found.unlinked_total, text.length / 6);
    assert.ok(found.unlinked.every((mention) => mention.context.length <= 242));
  });
});

test('a text over the work cap is reported as too large to analyse instead of being parsed', () => {
  // A string longer than the cap without allocating it: the length is all analyseBook looks at first.
  const huge = { length: MAX_ANALYSED_CHARS + 1 } as unknown as string;
  const analysis = analyseBook({ notes: [{ name: 'Elena', text: '' }], scenes: [{ file: 'scenes/1.md', text: huge }, { file: 'scenes/2.md', text: '[[Elena]]' }] });
  assert.deepEqual(analysis.too_large, [{ source_kind: 'scene', source: 'scenes/1.md', chars: MAX_ANALYSED_CHARS + 1 }]);
  assert.deepEqual(analysis.links.map((link) => link.source), ['scenes/2.md'], 'the other scenes are still analysed');
});

test('the paragraph co-occurrence weight over many paragraphs runs in linear time', () => {
  const two = (scene: string) => analyseBook({ notes: [{ name: 'A', text: '' }, { name: 'B', text: '' }], scenes: [{ file: 'scenes/1.md', text: scene }] });
  linear('paragraphs', repeat('[[A]] y [[B]].\n\n'), (text) => {
    const edge = buildGraph(two(text), undefined, { paragraphs: true }).edges.find((e) => e.kind === 'cooccurs')!;
    assert.equal(edge.paragraphs, text.length / 16);
  });
});

test('PageRank and knows edges over a growing chain of notes run in linear time', () => {
  // One note per 16 characters of "size", each linking the next, and one knowledge claim per note.
  const chain = (size: number) => {
    const count = Math.floor(size / 16);
    const names = Array.from({ length: count }, (_, i) => `N${i}`);
    const analysis = analyseBook({ notes: names.map((name, i) => ({ name, text: i + 1 < count ? `[[N${i + 1}]]` : '' })), scenes: [{ file: 'scenes/1.md', text: '' }] });
    const claims: KnowledgeClaim[] = names.map((name, i) => ({ claim_id: `C-${i}`, subject: name, source_file: 'scenes/1.md', editorial_status: 'proposed', knowledge: { holder: 'N0', fact: name, mode: 'displays' } }));
    return { analysis, graph: buildGraph(analysis), claims, count };
  };
  linear('pagerank', chain, ({ graph, count }) => assert.equal(pageRank(graph).size, count + 1), 'every note and the scene');
  linear('knows', chain, ({ analysis, claims, count }) => assert.equal(knowsEdges(analysis, claims).edges.length, count));
});

/** Every pair of `count` notes co-occurs: the densest graph of that size. */
function complete(count: number): StoryGraph {
  const ids = Array.from({ length: count }, (_, i) => `note:N${String(i).padStart(4, '0')}`);
  const edges = [];
  for (let i = 0; i < count; i += 1) for (let j = i + 1; j < count; j += 1) edges.push({ kind: 'cooccurs' as const, from: ids[i], to: ids[j], weight: 1 });
  return { nodes: ids.map((id) => ({ id, kind: 'note' as const, name: id.slice(5), type: null, order: null })), edges };
}

test('the densest graph that suggestions and betweenness accept answers within a second (timed with REWRITE_SCALE_FULL=1)', (t) => {
  // A complete graph of k notes costs k (k - 1)^2 suggestion steps and k^3 betweenness steps.
  let k = 2;
  while ((k + 1) * k * k <= MAX_SUGGEST_WORK) k += 1;
  assert.ok(suggestionCost(complete(k)) <= MAX_SUGGEST_WORK);
  assert.ok(suggestionCost(complete(k + 1)) > MAX_SUGGEST_WORK);
  let n = 2;
  while ((n + 1) ** 3 <= MAX_GRAPH_WORK) n += 1;
  if (!FULL) return;
  for (const [name, run] of [
    [`suggestions on ${k} notes`, () => suggestLinks(complete(k), { metric: 'adamic_adar', top: 10 })],
    [`betweenness on ${n} notes`, () => betweenness(complete(n))],
  ] as const) {
    const start = performance.now();
    run();
    const ms = performance.now() - start;
    t.diagnostic(`${name}: ${Math.round(ms)} ms`);
    assert.ok(ms < BOUND_MS, `${name}: ${Math.round(ms)} ms`);
  }
});
