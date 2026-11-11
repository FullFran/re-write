import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { until } from './fixtures/engine/harness.ts';
import { git } from './helpers.ts';
import { reviewApi, startHarness, type Harness } from './server-helpers.ts';

let h: Harness;
before(async () => {
  h = await startHarness();
  mkdirSync(join(h.bookDir, 'notas'), { recursive: true });
  writeFileSync(join(h.bookDir, 'notas', 'Elena.md'), '---\ntype: personaje\naliases: [la capitana]\n---\nGuarda el [[Puente de Sal]].\n');
  writeFileSync(join(h.bookDir, 'notas', 'Ángel Peña.md'), 'Habla con [[Elena]] y con [[Nadie]].\n');
  git(h.bookDir, 'add', 'notas');
  git(h.bookDir, '-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '-qm', 'notes');
});
after(() => h.close());

const notePath = (name: string) => `/books/sal/notes/${encodeURIComponent(name)}`;

test('a person lists the notes of a book with their frontmatter and unresolved links', async () => {
  const res = await reviewApi(h, '/books/sal/notes', await h.session());
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual(body.notes.map(({ name, file, type, aliases }: any) => ({ name, file, type, aliases })), [
    { name: 'Elena', file: 'notas/Elena.md', type: 'personaje', aliases: ['la capitana'] },
    { name: 'Ángel Peña', file: 'notas/Ángel Peña.md', type: null, aliases: [] },
  ]);
  assert.deepEqual(body.unresolved.map((group: any) => group.target), ['Puente de Sal', 'Nadie']);
  assert.equal((await reviewApi(h, '/books/sal/notes')).status, 401, 'only a signed-in person');
  assert.equal((await reviewApi(h, '/books/sal/notes', await h.session('user_stranger'))).status, 404, 'a stranger gets the answer of a book that does not exist');
});

test('a person reads one note with the version an edit starts from, its links and backlinks', async () => {
  const res = await reviewApi(h, notePath('Elena'), await h.session());
  assert.equal(res.status, 200);
  const note = await res.json();
  assert.equal(note.text, readFileSync(join(h.bookDir, 'notas', 'Elena.md'), 'utf8'));
  assert.equal(note.blob, git(h.bookDir, 'hash-object', 'notas/Elena.md'));
  assert.deepEqual(note.links.map((link: any) => link.target), ['Puente de Sal']);
  assert.deepEqual(note.backlinks.linked.map((m: any) => [m.source, m.raw]), [['Ángel Peña', '[[Elena]]']]);
  assert.equal((await reviewApi(h, notePath('Nadie'), await h.session())).status, 404);
  assert.equal((await reviewApi(h, '/books/sal/notes/..%2Fscenes%2Fescena-01', await h.session())).status, 404);
});

test('a person saves an edit of a note in one commit, and an edit on an old version is refused with the current text', async () => {
  const session = await h.session();
  const opened = await (await reviewApi(h, notePath('Ángel Peña'), session)).json();
  const head = git(h.bookDir, 'rev-parse', 'HEAD');
  const text = 'Habla con [[Elena]].\n';
  const saved = await reviewApi(h, notePath('Ángel Peña'), session, { base_blob: opened.blob, text });
  assert.equal(saved.status, 200);
  assert.equal((await saved.json()).changed, true);
  assert.equal(readFileSync(join(h.bookDir, 'notas', 'Ángel Peña.md'), 'utf8'), text);
  assert.equal(git(h.bookDir, 'rev-parse', 'HEAD~1'), head, 'exactly one commit');
  assert.equal(git(h.bookDir, '-c', 'core.quotepath=off', 'diff', '--name-only', head, 'HEAD'), 'notas/Ángel Peña.md');
  assert.match(git(h.bookDir, 'log', '-1', '--format=%b'), /^Edited-by: user_fran$/m);

  const stale = await reviewApi(h, notePath('Ángel Peña'), session, { base_blob: opened.blob, text: 'otra cosa' });
  assert.equal(stale.status, 409);
  assert.deepEqual((await stale.json()).current.text, text);
  assert.equal(readFileSync(join(h.bookDir, 'notas', 'Ángel Peña.md'), 'utf8'), text);
  assert.equal((await reviewApi(h, notePath('Nadie'), session, { base_blob: opened.blob, text: 'x' })).status, 404);
  assert.equal((await reviewApi(h, notePath('Elena'), session, { text: 'x' })).status, 400);
});

test('note routes are logged under their own route names', async (t) => {
  const lines: string[] = [];
  t.mock.method(console, 'log', (...args: unknown[]) => lines.push(args.join(' ')));
  t.mock.method(console, 'warn', () => {});
  t.mock.method(console, 'error', (...args: unknown[]) => lines.push(args.join(' ')));
  const logged = await startHarness();
  t.after(() => logged.close());
  const session = await logged.session();
  await reviewApi(logged, '/books/sal/notes', session);
  await reviewApi(logged, '/books/sal/notes/Elena', session);
  // The line is written when the response finishes, which can come after the client has the body.
  await until(() => lines.filter((line) => line.includes('"http.request"')).length >= 2);
  const routes = lines.map((line) => JSON.parse(line)).filter((r) => r.event === 'http.request').map((r) => r.route);
  assert.deepEqual(routes, ['/review/api/books/:book/notes', '/review/api/books/:book/notes/:name']);
});

test('accepting a new note answers 409 and writes nothing while that note file has uncommitted changes', async () => {
  const project = h.library.open('sal', 'user_fran');
  const { proposal } = project.proposeNote({ name: 'Carta', text: 'Una carta.\n', rationale: 'r' });
  writeFileSync(join(h.bookDir, 'notas', 'Carta.md'), 'x');
  git(h.bookDir, 'add', 'notas/Carta.md');
  git(h.bookDir, '-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '-qm', 'carta');
  rmSync(join(h.bookDir, 'notas', 'Carta.md'));
  const head = git(h.bookDir, 'rev-parse', 'HEAD');
  const res = await reviewApi(h, `/books/sal/proposals/${proposal.proposal_id}`, await h.session(), { decision: 'accept' });
  assert.equal(res.status, 409);
  assert.match((await res.json()).detail, /notas\/Carta\.md has uncommitted changes/);
  assert.equal(existsSync(join(h.bookDir, 'notas', 'Carta.md')), false);
  assert.equal(git(h.bookDir, 'rev-parse', 'HEAD'), head);
});
