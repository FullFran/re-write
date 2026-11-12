import assert from 'node:assert/strict';
import { test } from 'node:test';
import { git, read } from './helpers.ts';
import { Project } from '../src/application/project.ts';
import { manuscriptView } from '../src/application/manuscript-view.ts';
import { reviewApi, startHarness } from './server-helpers.ts';

// GET /review/api/books/:id/manuscript: the whole book in one read-only request (the Libro place).

const words = (text: string) => (text.match(/[\p{L}\p{N}]+(?:['’-][\p{L}\p{N}]+)*/gu) ?? []).length;

test('the manuscript route returns the ordered scenes with text, title and counts in one request, and commits nothing', async (t) => {
  const h = await startHarness();
  t.after(() => h.close());
  const session = await h.session();
  const head = git(h.bookDir, 'rev-parse', 'HEAD');
  const res = await reviewApi(h, '/books/sal/manuscript', session);
  assert.equal(res.status, 200);
  const body = await res.json();
  const order = Project.open(h.bookDir).scenes();
  assert.deepEqual(body.scenes.map((s: any) => s.file), order);
  for (const scene of body.scenes) {
    assert.equal(scene.text, read(h.bookDir, scene.file));
    assert.equal(scene.words, words(scene.text));
    assert.equal(typeof scene.title, 'string');
  }
  assert.equal(body.scenes[0].title, 'La puerta de Sal', 'the title is the first heading');
  assert.equal(body.total_words, body.scenes.reduce((n: number, s: any) => n + s.words, 0));
  assert.equal(body.truncated, false);
  assert.equal(git(h.bookDir, 'rev-parse', 'HEAD'), head, 'reading commits nothing');
});

test('?text=0 returns the counts without the text', async (t) => {
  const h = await startHarness();
  t.after(() => h.close());
  const body = await (await reviewApi(h, '/books/sal/manuscript?text=0', await h.session())).json();
  assert.equal(body.scenes.length, 2);
  assert.ok(body.scenes.every((s: any) => !('text' in s) && s.words > 0));
  assert.ok(body.total_words > 0);
});

test('the manuscript is refused to a non-member and to a call without a session', async (t) => {
  const h = await startHarness();
  t.after(() => h.close());
  assert.equal((await reviewApi(h, '/books/sal/manuscript')).status, 401);
  const other = await reviewApi(h, '/books/sal/manuscript', await h.session('user_other'));
  assert.ok([403, 404].includes(other.status), `a stranger gets ${other.status}`);
  assert.equal((await reviewApi(h, '/books/sal/manuscript', await h.session(), {})).status >= 400, true, 'there is no write verb');
});

test('past the size cap the remaining scenes keep their counts but not their text', () => {
  const fake = {
    title: () => 'Libro',
    scenes: () => ['scenes/a.md', 'scenes/b.md'],
    outline: () => ({ version: 'none', chapters: [], loose: [], archived: [] }),
    readScene: (file: string) => (file === 'scenes/a.md' ? '# A\nuno dos tres\n' : '# B\ncuatro cinco\n'),
  } as unknown as Project;
  const view = manuscriptView(fake, { maxBytes: 20 });
  assert.equal(view.truncated, true);
  assert.equal(view.scenes[0].text, '# A\nuno dos tres\n');
  assert.equal(view.scenes[1].text, null);
  assert.equal(view.scenes[1].words, 3, 'counted although not sent');
  assert.equal(view.total_words, 7, 'A, uno, dos, tres + B, cuatro, cinco');
});

test('the manuscript follows the book: each scene names its chapter, and a manifest title wins over the heading', async (t) => {
  const h = await startHarness();
  t.after(() => h.close());
  const project = Project.open(h.bookDir);
  const [first, second] = project.scenes();
  const step = (op: any) => project.editStructure(project.outline().version, op, 'user_fran');
  step({ op: 'create_chapter', title: 'Primera parte' });
  step({ op: 'move_scene', file: second, chapter: project.outline().chapters[0].id });
  step({ op: 'retitle_scene', file: second, title: 'El altar, de noche' });
  const body = await (await reviewApi(h, '/books/sal/manuscript', await h.session())).json();
  assert.deepEqual(body.scenes.map((s: any) => [s.file, s.chapter, s.title]),
    [[second, 'Primera parte', 'El altar, de noche'], [first, null, 'La puerta de Sal']]);
});
