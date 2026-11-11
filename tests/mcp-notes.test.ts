import assert from 'node:assert/strict';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Library } from '../src/application/library.ts';
import { buildMcpServer } from '../src/adapters/mcp.ts';
import { cli, git, tempDir } from './helpers.ts';

const GRAPH_TOOLS = ['graph_neighbors', 'graph_orphans', 'graph_path', 'graph_central', 'graph_suggest_links'];

/** A book with three linked scenes and no notes yet, and a connected assistant. */
async function setup() {
  const data = tempDir();
  const book = join(data, 'books', 'sal');
  const src = tempDir();
  const scenes = {
    '001-lluvia.md': 'Llovía. La capitana miró el río. Luego [[Elena]] cruzó el [[Puente de Sal|puente]] con [[Nadie]].\n',
    '002-carta.md': 'Tomás habló con [[Elena]]; elena no respondió.\n',
    '003-alba.md': '[[Tomás]] y [[Puente de Sal]] al alba.\n',
  };
  for (const [name, text] of Object.entries(scenes)) writeFileSync(join(src, name), text);
  cli('init', book);
  cli('import', book, ...Object.keys(scenes).map((name) => join(src, name)));
  const lib = new Library(data);
  lib.grant('sal', 'user_fran');
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await buildMcpServer(lib, 'user_fran').connect(serverSide);
  const client = new Client({ name: 'test', version: '1' });
  await client.connect(clientSide);
  const call = async (name: string, args: object) => {
    const result: any = await client.callTool({ name, arguments: { book: 'sal', ...args } as Record<string, unknown> });
    return { isError: Boolean(result.isError), data: result.isError ? null : JSON.parse(result.content[0].text), structured: result.structuredContent, text: result.content[0]?.text as string };
  };
  /** The assistant proposes each note; the person accepts it outside the MCP. */
  const addNotes = async (notes: Record<string, string>) => {
    for (const [name, text] of Object.entries(notes)) {
      const { data } = await call('propose_note', { name, text, rationale: 'Ficha' });
      lib.open('sal', 'user_fran').reviewProposal(data.proposal.proposal_id, 'accept', 'user_fran');
    }
  };
  return { lib, book, client, call, addNotes };
}

const NOTES = {
  Elena: '---\ntype: personaje\naliases: [la capitana]\n---\nCustodia el [[Puente de Sal]].\n',
  'Puente de Sal': '---\ntype: lugar\n---\nLo cruza [[Tomás]].\n',
  Tomás: '---\ntype: personaje\n---\nUn viajero.\n',
  Carta: '---\ntype: objeto\n---\nNadie la ha leído.\n',
};

test('propose_note stores a proposal and writes no note; only a person accepting it creates the note', async () => {
  const { lib, book, call } = await setup();
  const commits = git(book, 'rev-list', '--count', 'HEAD');
  const proposed = await call('propose_note', { name: 'Elena', text: NOTES.Elena, rationale: 'Ficha del personaje' });
  assert.equal(proposed.isError, false);
  assert.equal(proposed.data.created, true);
  assert.equal(proposed.data.proposal.file, 'notas/Elena.md');
  assert.equal(proposed.data.proposal.creates, true);
  assert.match(proposed.data.next_step, /You cannot accept or reject anything/);
  assert.deepEqual(proposed.structured, proposed.data);
  assert.equal(existsSync(join(book, 'notas', 'Elena.md')), false);
  assert.equal(Number(git(book, 'rev-list', '--count', 'HEAD')), Number(commits) + 1, 'only the proposal record is committed');
  assert.deepEqual((await call('list_notes', {})).data.notes, []);
  lib.open('sal', 'user_fran').reviewProposal(proposed.data.proposal.proposal_id, 'accept', 'user_fran');
  assert.deepEqual((await call('list_notes', {})).data.notes.map((n: any) => n.name), ['Elena']);
  const again = await call('propose_note', { name: 'elena', text: 'x', rationale: 'r' });
  assert.equal(again.isError, true);
  assert.match(again.text, /differs from the existing note "Elena" only by case or accents/);
  assert.match(again.text, /Next step: .*read_note.*propose_revision/);
});

test('list_notes gives each note with its frontmatter, and the links that name no note or several', async () => {
  const { call, addNotes } = await setup();
  await addNotes({ ...NOTES, Ana: '---\naliases: [Tomás el viejo]\n---\n', Otra: '---\naliases: [tomas el viejo]\n---\n' });
  const listed = await call('list_notes', {});
  assert.equal(listed.isError, false);
  assert.deepEqual(listed.data.notes.map(({ name, file, type, aliases }: any) => ({ name, file, type, aliases })).slice(0, 3), [
    { name: 'Ana', file: 'notas/Ana.md', type: null, aliases: ['Tomás el viejo'] },
    { name: 'Carta', file: 'notas/Carta.md', type: 'objeto', aliases: [] },
    { name: 'Elena', file: 'notas/Elena.md', type: 'personaje', aliases: ['la capitana'] },
  ]);
  assert.equal(listed.data.total, 6);
  assert.deepEqual(listed.data.unresolved, [{ target: 'Nadie', occurrences: 1, first: { source: 'scenes/001-lluvia.md', line: 1, column: 88 } }]);
  assert.deepEqual(listed.data.ambiguous, []);
  assert.deepEqual(listed.structured, listed.data);
});

test('read_note returns the text, its links and its backlinks, linked and unlinked', async () => {
  const { call, addNotes } = await setup();
  await addNotes(NOTES);
  const { data, structured } = await call('read_note', { name: 'elena' });
  assert.deepEqual(structured, data);
  assert.equal(data.name, 'Elena', 'a name is found like a wikilink: case and accents do not matter');
  assert.equal(data.text, NOTES.Elena);
  assert.equal(data.type, 'personaje');
  assert.deepEqual(data.links.map((l: any) => [l.target, l.resolution.status]), [['Puente de Sal', 'resolved']]);
  assert.deepEqual(data.backlinks.linked.map((m: any) => [m.source, m.raw]), [['scenes/001-lluvia.md', '[[Elena]]'], ['scenes/002-carta.md', '[[Elena]]']]);
  assert.deepEqual(data.backlinks.unlinked.map((m: any) => [m.source, m.text, m.context]), [
    ['scenes/001-lluvia.md', 'La capitana', 'La capitana miró el río.'],
    ['scenes/002-carta.md', 'elena', 'Tomás habló con [[Elena]]; elena no respondió.'],
  ]);
  const missing = await call('read_note', { name: 'Nadie' });
  assert.equal(missing.isError, true);
  assert.match(missing.text, /unknown note: Nadie\nNext step: Call list_notes/);
});

test('graph tools answer neighbours, orphans, paths and degree, cut at as_of_scene, and never write', async () => {
  const { book, call, addNotes } = await setup();
  await addNotes(NOTES);
  const commits = git(book, 'rev-list', '--count', 'HEAD');
  const near = await call('graph_neighbors', { node: 'Tomás', depth: 1 });
  assert.deepEqual(near.structured, near.data);
  assert.deepEqual(near.data.nodes.map((n: any) => [n.id, n.distance]), [['note:Tomás', 0], ['note:Puente de Sal', 1], ['scene:scenes/003-alba.md', 1]]);
  assert.ok(near.data.edges.some((e: any) => e.kind === 'mention' && e.from === 'scene:scenes/003-alba.md' && e.to === 'note:Tomás'));
  const early = await call('graph_neighbors', { node: 'Tomás', depth: 1, as_of_scene: 'scenes/002-carta.md' });
  assert.deepEqual(early.data.nodes.map((n: any) => n.id), ['note:Tomás', 'note:Puente de Sal'], 'scene 3 is after the cut');
  assert.deepEqual((await call('graph_orphans', {})).data.orphans.map((n: any) => n.id), ['note:Carta']);
  const path = await call('graph_path', { from: 'scenes/002-carta.md', to: 'Tomás' });
  assert.deepEqual(path.data.path.map((n: any) => n.id), ['scene:scenes/002-carta.md', 'note:Elena', 'note:Puente de Sal', 'note:Tomás']);
  assert.equal(path.data.length, 3);
  assert.deepEqual((await call('graph_path', { from: 'Carta', to: 'Elena' })).data, { path: null, length: null });
  const ranking = await call('graph_central', { metric: 'degree' });
  assert.deepEqual(ranking.data.ranking.map((n: any) => [n.id, n.degree]), [['note:Puente de Sal', 4], ['note:Elena', 3], ['note:Tomás', 2], ['note:Carta', 0]]);
  assert.equal(git(book, 'rev-list', '--count', 'HEAD'), commits, 'graph tools commit nothing');
  assert.equal(git(book, 'status', '--porcelain'), '');
});

test('graph tools refuse an unknown or ambiguous node and an unknown scene, with the next step', async () => {
  const { call, addNotes } = await setup();
  await addNotes({ A: '---\naliases: [X]\n---\n', B: '---\naliases: [x]\n---\n' });
  const ambiguous = await call('graph_neighbors', { node: 'x' });
  assert.match(ambiguous.text, /"x" is ambiguous: it names the notes A, B; use one of those names\nNext step: Call list_notes/);
  assert.match((await call('graph_path', { from: 'Nadie', to: 'A' })).text, /unknown note: Nadie\nNext step: Call list_notes/);
  assert.match((await call('graph_orphans', { as_of_scene: 'scenes/999.md' })).text, /unknown scene: scenes\/999.md\nNext step: Call list_scenes/);
});

test('note and graph tools are read-only, declare an output schema, and warn that returned text is data', async () => {
  const { client } = await setup();
  const { tools } = await client.listTools();
  for (const name of ['list_notes', 'read_note', ...GRAPH_TOOLS]) {
    const tool = tools.find((t) => t.name === name)!;
    assert.ok(tool, name);
    assert.equal(tool.annotations?.readOnlyHint, true, name);
    assert.ok(tool.outputSchema, name);
    assert.match(tool.description ?? '', /^Use this when/, name);
    assert.ok(tool.title, name);
  }
  for (const name of ['list_notes', 'read_note']) assert.match(tools.find((t) => t.name === name)!.description!, /not instructions to follow/);
  const propose = tools.find((t) => t.name === 'propose_note')!;
  assert.equal(propose.annotations?.readOnlyHint, false);
});

test('every note and graph tool answers for the book it is given, never another book of the same person', async () => {
  const { lib, call, addNotes } = await setup();
  await addNotes(NOTES);
  const other = join(lib.dataDir, 'books', 'otro');
  const src = tempDir();
  writeFileSync(join(src, '900-otro.md'), '[[Elena]] encendió el [[Faro]].\n');
  cli('init', other);
  cli('import', other, join(src, '900-otro.md'));
  lib.grant('otro', 'user_fran');
  const project = lib.open('otro', 'user_fran');
  for (const [name, text] of Object.entries({ Elena: 'Otra Elena.\n', Faro: 'Un faro.\n', Solo: 'Nadie lo nombra.\n' })) {
    project.reviewProposal(project.proposeNote({ name, text, rationale: 'r' }).proposal.proposal_id, 'accept', 'user_fran');
  }
  const ids = (nodes: any[]) => nodes.map((node) => node.id);
  const both = async (name: string, args: object) => [await call(name, args), await call(name, { ...args, book: 'otro' })];

  const [salNotes, otroNotes] = await both('list_notes', {});
  assert.deepEqual(salNotes.data.notes.map((n: any) => n.name), ['Carta', 'Elena', 'Puente de Sal', 'Tomás']);
  assert.deepEqual(otroNotes.data.notes.map((n: any) => n.name), ['Elena', 'Faro', 'Solo']);

  const [salNote, otroNote] = await both('read_note', { name: 'Elena' });
  assert.equal(salNote.data.text, NOTES.Elena);
  assert.equal(otroNote.data.text, 'Otra Elena.\n');
  assert.deepEqual(salNote.data.backlinks.linked.map((m: any) => m.source), ['scenes/001-lluvia.md', 'scenes/002-carta.md']);
  assert.deepEqual(otroNote.data.backlinks.linked.map((m: any) => m.source), ['scenes/900-otro.md']);
  assert.deepEqual(otroNote.data.backlinks.unlinked, []);

  const [salNear, otroNear] = await both('graph_neighbors', { node: 'Elena' });
  assert.deepEqual(ids(salNear.data.nodes), ['note:Elena', 'note:Puente de Sal', 'scene:scenes/001-lluvia.md', 'scene:scenes/002-carta.md']);
  assert.deepEqual(ids(otroNear.data.nodes), ['note:Elena', 'note:Faro', 'scene:scenes/900-otro.md']);

  const [salOrphans, otroOrphans] = await both('graph_orphans', {});
  assert.deepEqual(ids(salOrphans.data.orphans), ['note:Carta']);
  assert.deepEqual(ids(otroOrphans.data.orphans), ['note:Solo']);

  const [salPath, otroPath] = await both('graph_path', { from: 'Elena', to: 'Faro' });
  assert.match(salPath.text, /unknown note: Faro/);
  assert.deepEqual(ids(otroPath.data.path), ['note:Elena', 'note:Faro']);

  const [salCentral, otroCentral] = await both('graph_central', {});
  assert.deepEqual(salCentral.data.ranking.map((n: any) => [n.id, n.degree]), [['note:Puente de Sal', 4], ['note:Elena', 3], ['note:Tomás', 2], ['note:Carta', 0]]);
  assert.deepEqual(otroCentral.data.ranking.map((n: any) => [n.id, n.degree]), [['note:Elena', 2], ['note:Faro', 2], ['note:Solo', 0]]);

  const [salSuggest, otroSuggest] = await both('graph_suggest_links', {});
  assert.deepEqual(salSuggest.data.suggestions.map((s: any) => [s.from, s.to]), [['note:Elena', 'note:Tomás']]);
  assert.deepEqual(otroSuggest.data.suggestions.map((s: any) => [s.from, s.to]), [['note:Elena', 'note:Faro']]);
  assert.deepEqual([otroSuggest.data.suggestions[0].anchors, otroSuggest.data.suggestions[0].anchor_problem], [[], 'no aparece en el texto: ninguna de las dos notas nombra a la otra']);
});

test('graph_suggest_links offers no anchor for a passage that is not unique, and says why', async () => {
  const { call, addNotes } = await setup();
  await addNotes({ ...NOTES, Elena: '---\ntype: personaje\naliases: [la capitana]\n---\nCustodia el [[Puente de Sal]].\nSaluda a Tomás.\nSaluda a Tomás.\n' });
  const [suggestion] = (await call('graph_suggest_links', { node: 'Elena' })).data.suggestions;
  assert.equal(suggestion.to, 'note:Tomás');
  assert.deepEqual(suggestion.anchors, []);
  assert.equal(suggestion.anchor_problem, 'el pasaje no es único: cada mención se repite igual en la nota');
});

const claimOn = (source_file: string, quote: string, subject: string, holder: string, fact: string, mode: string) => ({
  statement: `${holder} y ${subject}`, subject, source_file, quote, scope: 'book', epistemic_kind: 'belief', knowledge: { holder, fact, mode },
});

test('graph_neighbors with knows adds who-knows-what edges from claims, cut at as_of_scene, and reports names that match no note', async () => {
  const { call, addNotes } = await setup();
  await addNotes(NOTES);
  const proposed = await call('propose_claims', { extractor: 'test', candidates: [
    claimOn('scenes/001-lluvia.md', 'Luego [[Elena]] cruzó el', 'Puente de Sal', 'la capitana', 'puente', 'displays'),
    claimOn('scenes/002-carta.md', 'Tomás habló con [[Elena]]', 'Elena', 'Tomás', 'elena-calla', 'acquires'),
    claimOn('scenes/003-alba.md', '[[Tomás]] y [[Puente de Sal]] al alba.', 'El tesoro', 'Tomás', 'tesoro', 'hears'),
  ] });
  assert.deepEqual(proposed.data.rejected, []);
  const edges = (data: any) => data.knows.edges.map((e: any) => [e.from, e.to, e.mode, e.fact, e.scene, e.editorial_status]);
  const near = await call('graph_neighbors', { node: 'Elena', knows: true });
  assert.deepEqual(near.structured, near.data);
  assert.deepEqual(edges(near.data), [
    ['note:Elena', 'note:Puente de Sal', 'displays', 'puente', 'scenes/001-lluvia.md', 'proposed'],
    ['note:Tomás', 'note:Elena', 'acquires', 'elena-calla', 'scenes/002-carta.md', 'proposed'],
  ]);
  assert.deepEqual(near.data.knows.unresolved.map((p: any) => [p.role, p.name, p.scene]), [['subject', 'El tesoro', 'scenes/003-alba.md']]);
  assert.deepEqual(near.data.knows.ambiguous, []);
  const early = await call('graph_neighbors', { node: 'Elena', knows: true, as_of_scene: 'scenes/001-lluvia.md' });
  assert.deepEqual(edges(early.data), [['note:Elena', 'note:Puente de Sal', 'displays', 'puente', 'scenes/001-lluvia.md', 'proposed']]);
  assert.deepEqual(early.data.knows.unresolved, [], 'a later problem is a spoiler too');
  assert.equal('knows' in (await call('graph_neighbors', { node: 'Elena' })).data, false, 'without knows the answer is as before');
});

test('graph_central ranks by PageRank or betweenness on request, and degree stays the default', async () => {
  const { call, addNotes } = await setup();
  await addNotes(NOTES);
  const between = await call('graph_central', { metric: 'betweenness' });
  assert.equal(between.data.metric, 'betweenness');
  assert.deepEqual(between.data.ranking.map((n: any) => [n.id, n.betweenness]), [['note:Puente de Sal', 6], ['note:Elena', 4], ['note:Carta', 0], ['note:Tomás', 0]]);
  const rank = await call('graph_central', { metric: 'pagerank', kind: 'scene' });
  assert.equal(rank.data.metric, 'pagerank');
  assert.deepEqual(rank.data.ranking.map((n: any) => n.kind), ['scene', 'scene', 'scene']);
  const values = rank.data.ranking.map((n: any) => n.pagerank);
  assert.ok(values.every((v: number, i: number) => typeof v === 'number' && (i === 0 || values[i - 1] >= v)));
  const degree = await call('graph_central', {});
  assert.equal(degree.data.metric, 'degree');
  assert.equal('pagerank' in degree.data.ranking[0], false);
});

test('graph_suggest_links proposes notes to link, with literal anchors for propose_revision, and writes nothing', async () => {
  const { book, call, addNotes } = await setup();
  await addNotes({ ...NOTES, Tomás: '---\ntype: personaje\n---\nUn viajero que busca a Elena.\n' });
  const commits = git(book, 'rev-list', '--count', 'HEAD');
  const found = await call('graph_suggest_links', { node: 'Elena' });
  assert.deepEqual(found.structured, found.data);
  assert.equal(found.data.metric, 'adamic_adar');
  assert.deepEqual(found.data.suggestions, [{
    from: 'note:Elena', to: 'note:Tomás', score: 0.721348, common: 1, via: ['note:Puente de Sal'],
    anchors: [{ file: 'notas/Tomás.md', line: 4, column: 24, text: 'Elena', context: 'Un viajero que busca a Elena.', find: 'Un viajero que busca a Elena.', replace: 'Un viajero que busca a [[Elena]].' }],
    anchor_problem: null,
  }]);
  assert.match(found.data.next_step, /propose_revision/);
  const book1 = await call('graph_suggest_links', { top: 1 });
  assert.deepEqual(book1.data.suggestions.map((s: any) => [s.from, s.to, s.score]), [['note:Elena', 'note:Tomás', 0.721348]]);
  assert.match((await call('graph_suggest_links', { node: 'scenes/001-lluvia.md' })).text, /suggestions are between notes.*\nNext step: Call list_notes/);
  assert.equal(git(book, 'rev-list', '--count', 'HEAD'), commits, 'suggesting commits nothing');
  assert.equal(git(book, 'status', '--porcelain'), '');
});
