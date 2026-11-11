// The showcase book (fixtures/la-puerta-de-sal, docs/showcase.md): it loads through the product's
// own application layer, and what fixtures/la-puerta-de-sal/expected.json promises it shows holds.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { FIXTURES, tempDir } from './helpers.ts';
import { loadShowcase, SHOWCASE } from '../scripts/load-showcase.ts';
import { Library } from '../src/application/library.ts';
import { Project } from '../src/application/project.ts';
import { analyse, graphOf, knowsOf, ranking } from '../src/application/story.ts';
import { noteNode, shortestPath, orphans } from '../src/domain/story-graph.ts';
import { displayText } from '../src/domain/wikilink.ts';

process.env.GIT_CONFIG_GLOBAL = '/dev/null';
process.env.GIT_CONFIG_NOSYSTEM = '1';
process.env.HOME = tempDir();

const expected = JSON.parse(readFileSync(join(SHOWCASE, 'expected.json'), 'utf8'));
const annotations = JSON.parse(readFileSync(join(SHOWCASE, 'annotations.json'), 'utf8'));
const sceneText = (file: string) => readFileSync(join(SHOWCASE, file), 'utf8');

// One load shared by the read-only checks below; the loader test makes its own.
const data = tempDir();
const loaded = loadShowcase(data);
const project = Project.open(loaded.dir);

test('the loader builds the book through the application layer and refuses to load it twice', () => {
  const dir = tempDir();
  const result = loadShowcase(dir, { book: 'muestra', user: 'user_demo' });
  assert.equal(result.scenes.length, expected.counts.scenes);
  assert.equal(result.notes.length, expected.counts.notes);
  assert.deepEqual(result.claims, { created: annotations.candidates.length, accepted: expected.counts.accepted_claims, proposed: annotations.candidates.length - expected.counts.accepted_claims, rejected: [] });
  const book = Project.open(result.dir);
  assert.equal(book.title(), 'La puerta de Sal');
  assert.equal(book.git.isDirty('.'), false, 'everything it wrote is committed');
  assert.equal(book.proposals.all().filter((p) => p.status === 'accepted').length, expected.counts.notes, 'each note arrived as an accepted proposal');
  assert.equal(book.canon().length, expected.counts.accepted_claims);
  assert.equal(new Library(dir).canUse('muestra', 'user_demo'), true);
  const head = book.git.head();
  assert.throws(() => loadShowcase(dir, { book: 'muestra' }), /already exists/);
  assert.equal(book.git.head(), head, 'a refused load writes nothing');
  assert.equal(existsSync(join(dir, 'books', 'otro')), false);
});

test('the novel has the promised size, and its first two scenes read exactly as the demo book', () => {
  const scenes = readdirSync(join(SHOWCASE, 'scenes')).sort();
  assert.ok(scenes.length >= 16 && scenes.length <= 24, `${scenes.length} scenes`);
  const words = scenes.reduce((sum, f) => sum + sceneText(`scenes/${f}`).split(/\s+/).filter(Boolean).length, 0);
  assert.ok(words >= 12_000 && words <= 20_000, `${words} words`);
  assert.equal(displayText(sceneText('scenes/001-la-puerta-de-sal.md')), readFileSync(join(FIXTURES, 'escena-01.md'), 'utf8'));
  assert.equal(displayText(sceneText('scenes/002-el-altar.md')), readFileSync(join(FIXTURES, 'escena-02.md'), 'utf8'));
});

test('every annotation quote is literal and appears exactly once in its scene', () => {
  for (const candidate of annotations.candidates) {
    const occurrences = sceneText(candidate.source_file).split(candidate.quote).length - 1;
    assert.equal(occurrences, 1, `${candidate.source_file}: «${candidate.quote}»`);
  }
});

test('every note is well formed, every link resolves except the planted one, and the orphans are the planted ones', () => {
  const analysis = analyse(project);
  assert.deepEqual(analysis.notes.filter((n) => n.problems.length).map((n) => n.name), []);
  assert.deepEqual(analysis.notes.filter((n) => !n.type).map((n) => n.name), [], 'every note has a type');
  assert.deepEqual(analysis.unresolved.map((l) => [l.target, l.source]), [[expected.unresolved_link.target, expected.unresolved_link.scene]]);
  assert.deepEqual(analysis.ambiguous, []);
  const { graph } = graphOf(project);
  assert.deepEqual(orphans(graph).map((n) => n.name), expected.orphans);
});

test('the graph facts in expected.json hold: a shortest path, the top bridge and the designed groups', () => {
  const { graph } = graphOf(project);
  const { from, to, path } = expected.shortest_path;
  assert.deepEqual(shortestPath(graph, noteNode(from), noteNode(to)), path.map(noteNode));
  assert.equal(ranking(graph, 'betweenness', 'note')[0].name, expected.top_bridge);
  // Communities run in the browser (Louvain). Here, loosely: the designed groups have a clearly
  // positive modularity (the quantity Louvain maximises), above any shuffle of the same group sizes.
  const groups: Record<string, string[]> = expected.communities;
  const designed = new Map(Object.entries(groups).flatMap(([group, members]) => members.map((m) => [noteNode(m), group] as const)));
  const modularity = (of: Map<string, string>) => {
    const strength = new Map<string, number>();
    const inside = new Map<string, number>();
    let total = 0;
    for (const edge of graph.edges) {
      if (edge.from === edge.to || !of.has(edge.from) || !of.has(edge.to)) continue;
      total += edge.weight;
      for (const node of [edge.from, edge.to]) strength.set(node, (strength.get(node) ?? 0) + edge.weight);
      if (of.get(edge.from) === of.get(edge.to)) inside.set(of.get(edge.from)!, (inside.get(of.get(edge.from)!) ?? 0) + edge.weight);
    }
    let q = 0;
    for (const group of new Set(of.values())) {
      let degree = 0;
      for (const [node, g] of of) if (g === group) degree += strength.get(node) ?? 0;
      q += (inside.get(group) ?? 0) / total - (degree / (2 * total)) ** 2;
    }
    return q;
  };
  const q = modularity(designed);
  assert.ok(q > 0.1, `modularity ${q}`);
  let seed = 115;
  const random = () => (seed = (seed * 48271) % 2147483647) / 2147483647;
  for (let i = 0; i < 200; i += 1) {
    const nodes = [...designed.keys()];
    const labels = [...designed.values()];
    for (let j = labels.length - 1; j > 0; j -= 1) {
      const k = Math.floor(random() * (j + 1));
      [labels[j], labels[k]] = [labels[k], labels[j]];
    }
    assert.ok(modularity(new Map(nodes.map((node, n) => [node, labels[n]]))) < q, 'a shuffle of the groups is as tight as the design');
  }
});

test('the mystery stays hidden until its scene: no who-knows-what edge about it before the reveal', () => {
  const analysis = analyse(project);
  const { fact, reveal_scene, before_reveal, knowers } = expected.mystery;
  const about = (asOf?: string) => knowsOf(project, analysis, asOf).edges.filter((e) => e.fact === fact);
  assert.deepEqual(about(before_reveal), []);
  assert.deepEqual(about(reveal_scene).map((e) => [e.from, e.to, e.scene]), knowers.map((k: string) => [noteNode(k), noteNode(expected.mystery.subject), reveal_scene]));
  assert.deepEqual(knowsOf(project, analysis).unresolved, [], 'every holder and subject names a note');
});

test('the continuity check reports exactly the planted knowledge-order problems', () => {
  const findings = project.check();
  const planted = expected.continuity.knowledge_order;
  assert.deepEqual(
    findings.map((f) => [f.classification, f.holder, f.fact, f.citations.map((c) => c.quote)]).sort(),
    planted.map((p: any) => ['possible_contradiction', p.holder, p.fact, [p.shown.quote, p.learned.quote]]).sort(),
  );
});

test('the problems no rule checks are both in Canon, with their literal quotes, for a reader or the assistant', () => {
  const canon = project.canon();
  for (const problem of expected.continuity.for_a_reader) {
    for (const side of problem.quotes) {
      assert.ok(canon.some((c) => c.source_file === side.scene && c.anchor.quote === side.quote), `${problem.id}: «${side.quote}»`);
    }
  }
});
