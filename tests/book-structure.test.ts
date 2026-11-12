import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { buildMcpServer } from '../src/adapters/mcp.ts';
import { bookTree, countWords } from '../src/application/book-structure.ts';
import { BookStructureConflictError, Project } from '../src/application/project.ts';
import { graphOf } from '../src/application/story.ts';
import { BookStructureError, checkTitle, newScenePath, type StructureOp } from '../src/domain/book.ts';
import { cli, FIXTURES, git, newBook, tempDir } from './helpers.ts';
import { reviewApi, startHarness, type Harness } from './server-helpers.ts';

const A = 'scenes/escena-01.md';
const B = 'scenes/escena-02.md';
const MANIFEST = '.rewrite/book.json';

/** A book with escena-01 and escena-02 and extra scenes written straight into scenes/ (committed). */
function book(extra: string[] = []): Project {
  const dir = newBook();
  for (const name of extra) writeFileSync(join(dir, 'scenes', name), `Texto de ${name}\n`);
  if (extra.length) {
    git(dir, 'add', '-A');
    git(dir, 'commit', '-q', '-m', 'extra scenes');
  }
  return Project.open(dir);
}

const commits = (p: Project) => Number(git(p.dir, 'rev-list', '--count', 'HEAD'));
const write = (p: Project, op: StructureOp, version = p.outline().version) => p.editStructure(version, op, 'ana');

test('without a manifest the order is the sorted scene paths and no manifest file appears', () => {
  const p = book(['000-prologo.md', 'zeta.md']);
  assert.deepEqual(p.scenes(), ['scenes/000-prologo.md', A, B, 'scenes/zeta.md']);
  assert.deepEqual(p.archivedScenes(), []);
  assert.equal(p.outline().version, 'none');
  assert.equal(existsSync(join(p.dir, MANIFEST)), false);
});

test('a manifest sets the book order; scenes it does not list come after, sorted by path', () => {
  const p = book(['000-prologo.md', 'zeta.md']);
  writeFileSync(join(p.dir, MANIFEST), JSON.stringify({
    version: 1,
    chapters: [{ id: 'c1', title: 'Uno', scenes: [B, 'scenes/zeta.md'] }],
    loose: [A],
    titles: {},
    archived: [],
  }));
  assert.deepEqual(p.scenes(), [B, 'scenes/zeta.md', A, 'scenes/000-prologo.md']);
});

test('manifest entries whose file is gone, repeated entries and symlinks are ignored', () => {
  const p = book();
  symlinkSync('/etc/hostname', join(p.dir, 'scenes', 'link.md'));
  writeFileSync(join(p.dir, MANIFEST), JSON.stringify({
    version: 1,
    chapters: [{ id: 'c1', title: 'Uno', scenes: ['scenes/gone.md', B, B, 'scenes/link.md'] }],
    loose: ['scenes/../x.md', A],
    titles: {},
    archived: ['scenes/also-gone.md'],
  }));
  assert.deepEqual(p.scenes(), [B, A]);
  assert.deepEqual(p.archivedScenes(), []);
});

test('an unreadable manifest falls back to path order and structural writes are refused', () => {
  const p = book();
  writeFileSync(join(p.dir, MANIFEST), '{ not json');
  assert.deepEqual(p.scenes(), [A, B]);
  assert.throws(() => write(p, { op: 'create_chapter', title: 'X' }, 'whatever'), /not a valid book manifest/);
});

test('creating a scene: file derived from the title, placed in a chapter, one commit, only that scene and the manifest', () => {
  const p = book();
  const first = write(p, { op: 'create_chapter', title: 'Capítulo 1' });
  const chapter = first.outline.chapters[0].id;
  const before = commits(p);
  const made = write(p, { op: 'create_scene', title: '¿Dónde está Ñandú?', chapter, heading: true }, first.outline.version);
  assert.equal(made.file, 'scenes/donde-esta-nandu.md');
  assert.equal(readFileSync(join(p.dir, made.file!), 'utf8'), '# ¿Dónde está Ñandú?\n');
  assert.equal(commits(p), before + 1);
  assert.deepEqual(git(p.dir, 'show', '--name-only', '--format=', 'HEAD').split('\n').sort(), [MANIFEST, made.file!].sort());
  assert.deepEqual(p.scenes(), [made.file, A, B]);
  assert.equal(made.outline.chapters[0].scenes[0].title, '¿Dónde está Ñandú?');
  const empty = write(p, { op: 'create_scene', title: 'Vacía' }, made.outline.version);
  assert.equal(readFileSync(join(p.dir, empty.file!), 'utf8'), '');
  assert.equal(p.scenes().at(-1), empty.file, 'a new scene without a chapter goes to the end');
});

test('a new scene never reuses an existing path, even one that differs by case', () => {
  assert.equal(newScenePath('Escena 01', ['scenes/ESCENA-01.md']), 'scenes/escena-01-2.md');
  assert.equal(newScenePath('???', []), 'scenes/escena.md');
  const p = book();
  const one = write(p, { op: 'create_scene', title: 'Igual' });
  const two = write(p, { op: 'create_scene', title: 'Igual' }, one.outline.version);
  assert.deepEqual([one.file, two.file], ['scenes/igual.md', 'scenes/igual-2.md']);
});

test('titles are validated: empty, too long and control characters are refused and nothing is written', () => {
  const p = book();
  const before = commits(p);
  for (const title of ['', '   ', 'a'.repeat(121), 'dos\nlíneas', 'nul\u0000', 'sep ator', 'bidi‮override', 42 as any]) {
    assert.throws(() => write(p, { op: 'create_scene', title }), BookStructureError, JSON.stringify(title));
    assert.throws(() => write(p, { op: 'retitle_scene', file: A, title }), BookStructureError);
  }
  assert.equal(checkTitle('  Hola  '), 'Hola');
  assert.equal(commits(p), before);
  assert.equal(existsSync(join(p.dir, MANIFEST)), false);
  assert.equal(git(p.dir, 'status', '--porcelain'), '');
});

test('retitle a scene changes the display title only; the path and the text stay', () => {
  const p = book();
  const before = commits(p);
  const text = readFileSync(join(p.dir, A), 'utf8');
  const done = write(p, { op: 'retitle_scene', file: A, title: 'La puerta' });
  assert.equal(done.outline.loose.find((s) => s.file === A)?.title, 'La puerta');
  assert.deepEqual(p.scenes(), [A, B]);
  assert.equal(readFileSync(join(p.dir, A), 'utf8'), text);
  assert.equal(commits(p), before + 1);
  assert.equal(write(p, { op: 'retitle_scene', file: A, title: 'La puerta' }, done.outline.version).changed, false);
  assert.equal(commits(p), before + 1, 'the same title makes no commit');
});

test('archive removes a scene from scenes() but never deletes it; restore puts it back at the end', () => {
  const p = book();
  const before = commits(p);
  const archived = write(p, { op: 'archive_scene', file: A });
  assert.deepEqual(p.scenes(), [B]);
  assert.deepEqual(p.archivedScenes(), [A]);
  assert.deepEqual(archived.outline.archived.map((s) => s.file), [A]);
  assert.equal(existsSync(join(p.dir, A)), true);
  assert.notEqual(p.readScene(A), null, 'an archived scene stays readable by path');
  assert.equal(commits(p), before + 1);
  write(p, { op: 'unarchive_scene', file: A }, archived.outline.version);
  assert.deepEqual(p.scenes(), [B, A]);
  assert.deepEqual(p.archivedScenes(), []);
});

test('chapters: create, retitle, move and remove only when empty', () => {
  const p = book();
  let v = write(p, { op: 'create_chapter', title: 'Uno' }).outline;
  v = write(p, { op: 'create_chapter', title: 'Dos' }, v.version).outline;
  v = write(p, { op: 'create_chapter', title: 'Cero', position: 0 }, v.version).outline;
  assert.deepEqual(v.chapters.map((c) => c.title), ['Cero', 'Uno', 'Dos']);
  v = write(p, { op: 'retitle_chapter', chapter: v.chapters[1].id, title: 'Primero' }, v.version).outline;
  v = write(p, { op: 'move_chapter', chapter: v.chapters[2].id, position: 0 }, v.version).outline;
  assert.deepEqual(v.chapters.map((c) => c.title), ['Dos', 'Cero', 'Primero']);
  v = write(p, { op: 'move_scene', file: A, chapter: v.chapters[0].id, position: 0 }, v.version).outline;
  const full = v.chapters[0].id;
  assert.throws(() => write(p, { op: 'remove_chapter', chapter: full }, v.version), /no está vacío/);
  const empty = v.chapters[1].id;
  v = write(p, { op: 'remove_chapter', chapter: empty }, v.version).outline;
  assert.deepEqual(v.chapters.map((c) => c.title), ['Dos', 'Primero']);
  assert.throws(() => write(p, { op: 'remove_chapter', chapter: 'nope' }, v.version), BookStructureError);
});

test('moving scenes: within the loose list, into a chapter at a position, across chapters', () => {
  const p = book(['c.md']);
  let v = write(p, { op: 'create_chapter', title: 'Uno' }).outline;
  v = write(p, { op: 'create_chapter', title: 'Dos' }, v.version).outline;
  const [c1, c2] = v.chapters.map((c) => c.id);
  v = write(p, { op: 'move_scene', file: 'scenes/c.md', chapter: null, position: 0 }, v.version).outline;
  assert.deepEqual(p.scenes(), ['scenes/c.md', A, B]);
  v = write(p, { op: 'move_scene', file: A, chapter: c1, position: 0 }, v.version).outline;
  v = write(p, { op: 'move_scene', file: B, chapter: c1, position: 0 }, v.version).outline;
  assert.deepEqual(p.scenes(), [B, A, 'scenes/c.md']);
  v = write(p, { op: 'move_scene', file: B, chapter: c2 }, v.version).outline;
  assert.deepEqual(v.chapters.map((c) => c.scenes.map((s) => s.file)), [[A], [B]]);
  assert.deepEqual(p.scenes(), [A, B, 'scenes/c.md'], 'chapter order, then the loose scenes');
  v = write(p, { op: 'move_scene', file: A, chapter: c1, position: 99 }, v.version).outline;
  assert.throws(() => write(p, { op: 'move_scene', file: A, chapter: 'nope' }, v.version), BookStructureError);
  assert.throws(() => write(p, { op: 'move_scene', file: A, chapter: c1, position: -1 }, v.version), BookStructureError);
  assert.throws(() => write(p, { op: 'move_scene', file: 'scenes/none.md', chapter: c1 }, v.version), BookStructureError);
  assert.throws(() => write(p, { op: 'move_scene', file: '../outside.md', chapter: c1 }, v.version), BookStructureError);
  for (const file of [A, B, 'scenes/c.md']) assert.equal(existsSync(join(p.dir, file)), true, 'scene files never move');
});

test('a stale manifest version is refused with the current outline and writes nothing', () => {
  const p = book();
  const seen = p.outline().version;
  write(p, { op: 'create_chapter', title: 'Uno' }, seen);
  const before = commits(p);
  assert.throws(() => write(p, { op: 'create_chapter', title: 'Dos' }, seen), (e: unknown) =>
    e instanceof BookStructureConflictError && e.outline.chapters.length === 1);
  assert.equal(commits(p), before);
  assert.equal(p.outline().chapters.length, 1);
});

test('uncommitted manifest edits are refused instead of swept into a commit', () => {
  const p = book();
  write(p, { op: 'create_chapter', title: 'Uno' });
  const text = readFileSync(join(p.dir, MANIFEST), 'utf8');
  writeFileSync(join(p.dir, MANIFEST), text.replace('Uno', 'Uno!'));
  assert.throws(() => write(p, { op: 'create_chapter', title: 'Dos' }), /uncommitted/);
});

test('findings and claims on an archived scene still work', () => {
  const dir = newBook();
  assert.equal(cli('extract', dir, '--from', join(FIXTURES, 'annotations.json')).code, 0);
  const p = Project.open(dir);
  const claimsBefore = p.claimViews().map((c) => [c.claim_id, c.evidence_status]);
  const findingsBefore = p.check().map((f) => f.finding_id);
  assert.ok(claimsBefore.length > 0);
  const source = p.claimViews()[0].source_file;
  write(p, { op: 'archive_scene', file: source });
  assert.equal(p.scenes().includes(source), false);
  assert.deepEqual(p.claimViews().map((c) => [c.claim_id, c.evidence_status]), claimsBefore);
  assert.deepEqual(p.check().map((f) => f.finding_id), findingsBefore);
  assert.notEqual(p.readScene(source), null);
});

test('graph as_of_scene follows book order, and is the sorted order without a manifest', () => {
  const p = book();
  assert.deepEqual(graphOf(p).analysis.scenes, [A, B]);
  write(p, { op: 'move_scene', file: B, chapter: null, position: 0 });
  assert.deepEqual(graphOf(p).analysis.scenes, [B, A]);
  assert.throws(() => graphOf(p, 'scenes/missing.md'), /unknown scene/);
});

test('the word count and the tree: per scene, per chapter, and the book total of active scenes', () => {
  assert.equal(countWords("Ari's well-known door, 3 times."), 5);
  const p = book();
  const v = write(p, { op: 'create_chapter', title: 'Uno' }).outline;
  write(p, { op: 'move_scene', file: A, chapter: v.chapters[0].id }, v.version);
  const tree = bookTree(p);
  const words = (file: string) => countWords(readFileSync(join(p.dir, file), 'utf8'));
  assert.equal(tree.chapters[0].scenes[0].words, words(A));
  assert.equal(tree.chapters[0].words, words(A));
  assert.equal(tree.loose[0].words, words(B));
  assert.equal(tree.total_words, words(A) + words(B));
  write(p, { op: 'archive_scene', file: B });
  const after = bookTree(p);
  assert.equal(after.total_words, words(A), 'archived scenes are not in the total');
  assert.equal(after.archived[0].file, B);
  assert.ok(after.archived[0].title.length > 0);
});

// --- HTTP and MCP ------------------------------------------------------------------------------

let h: Harness;
before(async () => { h = await startHarness(); });
after(() => h.close());

const structure = (session: string | undefined, body: unknown) => reviewApi(h, '/books/sal/structure', session, body);

test('over HTTP: a person reorganises the book; reads need no write permission, writes are refused without a session', async () => {
  const session = await h.session();
  const tree = await (await reviewApi(h, '/books/sal/tree', session)).json();
  assert.equal(tree.version, 'none');
  assert.deepEqual(tree.loose.map((s: any) => s.file), [A, B]);
  assert.equal((await structure(undefined, { version: tree.version, op: 'create_chapter', title: 'X' })).status, 401);

  const head = git(h.bookDir, 'rev-list', '--count', 'HEAD');
  const res = await structure(session, { version: tree.version, op: 'create_scene', title: 'Nueva', heading: true });
  assert.equal(res.status, 200);
  const done = await res.json();
  assert.equal(done.file, 'scenes/nueva.md');
  assert.equal(done.tree.loose.at(-1).file, 'scenes/nueva.md');
  assert.equal(Number(git(h.bookDir, 'rev-list', '--count', 'HEAD')), Number(head) + 1);
  assert.equal(JSON.parse(readFileSync(join(h.bookDir, MANIFEST), 'utf8')).titles['scenes/nueva.md'], 'Nueva');

  const stale = await structure(session, { version: tree.version, op: 'create_chapter', title: 'Tarde' });
  assert.equal(stale.status, 409);
  const body = await stale.json();
  assert.equal(body.tree.version, done.tree.version, 'the refusal carries the current tree');
  assert.equal(Number(git(h.bookDir, 'rev-list', '--count', 'HEAD')), Number(head) + 1);

  const bad = await structure(session, { version: done.tree.version, op: 'create_scene', title: 'x\ny' });
  assert.equal(bad.status, 400);
  const gone = await structure(session, { version: done.tree.version, op: 'archive_scene', file: 'scenes/none.md' });
  assert.equal(gone.status, 404);
  assert.equal((await structure(session, { op: 'create_chapter', title: 'x' })).status, 400);

  const queue = await (await reviewApi(h, '/books/sal', session)).json();
  assert.deepEqual(queue.scenes, [A, B, 'scenes/nueva.md']);
  const archived = await structure(session, { version: done.tree.version, op: 'archive_scene', file: A });
  assert.equal(archived.status, 200);
  const list = await (await reviewApi(h, '/books/sal/scenes', session)).json();
  assert.deepEqual(list.scenes, [B, 'scenes/nueva.md']);
  assert.equal((await reviewApi(h, `/books/sal/scenes/${encodeURIComponent(A)}`, session)).status, 200, 'an archived scene opens by path');
});

test('MCP list_scenes returns book order and the tool list is unchanged by the manifest', async () => {
  const dir = h.bookDir;
  const lib = h.library;
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await buildMcpServer(lib, 'user_fran').connect(serverSide);
  const client = new Client({ name: 'test', version: '1' });
  await client.connect(clientSide);
  try {
    const names = (await client.listTools()).tools.map((t) => t.name);
    assert.ok(!names.some((n) => /structure|chapter|archive|outline|tree/.test(n)), 'no structure tool for agents');
    const listed = names.find((n) => n === 'list_scenes')!;
    const result = await client.callTool({ name: listed, arguments: { book: 'sal' } });
    const data = (result.structuredContent ?? JSON.parse((result.content as any)[0].text)) as { scenes: string[] };
    assert.deepEqual(data.scenes, Project.open(dir).scenes());
  } finally {
    await client.close();
  }
});

test('Project.scenes still lists a book with no manifest as sorted scenes/*.md (imported books keep working)', () => {
  const dir = join(tempDir(), 'imported');
  mkdirSync(dir, { recursive: true });
  cli('init', dir);
  for (const name of ['010-b.md', '002-a.md', '100-c.md']) writeFileSync(join(dir, '..', name), 'Texto.\n');
  cli('import', dir, ...['010-b.md', '002-a.md', '100-c.md'].map((n) => join(dir, '..', n)));
  assert.deepEqual(Project.open(dir).scenes(), ['scenes/002-a.md', 'scenes/010-b.md', 'scenes/100-c.md']);
});
