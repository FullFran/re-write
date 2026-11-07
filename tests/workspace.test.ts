import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { cli, FIXTURES } from './helpers.ts';
import { startHarness, type Harness } from './server-helpers.ts';

let h: Harness;
before(async () => {
  h = await startHarness();
});
after(() => h.close());

function api(path: string, token?: string, body?: unknown) {
  return fetch(`${h.base}/review/api${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

test('create book: owner gets access, others do not', async () => {
  const authorSession = await h.session('user_author');
  const strangerSession = await h.session('user_stranger');

  // Author creates a new book with a title
  const createRes = await api('/books', authorSession, { title: 'El guardián entre el centeno' });
  assert.equal(createRes.status, 201);
  const created = await createRes.json();
  assert.equal(created.book_id, 'el-guardian-entre-el-centeno');
  assert.equal(created.title, 'El guardián entre el centeno');

  // Author sees the new book in their book list
  const authorBooksRes = await api('/books', authorSession);
  assert.equal(authorBooksRes.status, 200);
  const authorBooks = await authorBooksRes.json();
  assert.ok(authorBooks.books.some((b: any) => b.book_id === 'el-guardian-entre-el-centeno'));

  // Author can access the book queue
  const bookRes = await api('/books/el-guardian-entre-el-centeno', authorSession);
  assert.equal(bookRes.status, 200);

  // Stranger does not see the book in their list
  const strangerBooksRes = await api('/books', strangerSession);
  const strangerBooks = await strangerBooksRes.json();
  assert.ok(!strangerBooks.books.some((b: any) => b.book_id === 'el-guardian-entre-el-centeno'));

  // Stranger gets 404 for the new book, identical to non-existent book
  const strangerRes = await api('/books/el-guardian-entre-el-centeno', strangerSession);
  const missingRes = await api('/books/non-existent-book', strangerSession);
  assert.equal(strangerRes.status, 404);
  assert.equal(missingRes.status, 404);
  assert.deepEqual(await strangerRes.json(), await missingRes.json());

  // Attempting to recreate the same book is refused with 409 Conflict
  const duplicateRes = await api('/books', authorSession, { title: 'El guardián entre el centeno' });
  assert.equal(duplicateRes.status, 409);

  // Invalid title or slug is rejected with 400
  const invalidRes = await api('/books', authorSession, { title: '   ' });
  assert.equal(invalidRes.status, 400);
});

test('import Markdown: success, overwrite refusal, oversize refusal, non-markdown refusal', async () => {
  const authorSession = await h.session('user_author2');
  const createRes = await api('/books', authorSession, { title: 'Libro de prueba' });
  assert.equal(createRes.status, 201);
  const bookId = (await createRes.json()).book_id;

  // 1. Success: import two markdown scenes
  const importRes = await api(`/books/${bookId}/import`, authorSession, {
    files: [
      { name: 'escena-01.md', content: '# Escena 1\nEl bosque callaba en la penumbra.' },
      { name: 'escena-02.md', content: '# Escena 2\nSalió el sol entre los árboles.' },
    ],
  });
  assert.equal(importRes.status, 200);
  const importData = await importRes.json();
  assert.deepEqual(importData.imported, ['scenes/escena-01.md', 'scenes/escena-02.md']);
  assert.deepEqual(importData.unchanged, []);

  // Importing identical files reports them as unchanged
  const repeatRes = await api(`/books/${bookId}/import`, authorSession, {
    files: [
      { name: 'escena-01.md', content: '# Escena 1\nEl bosque callaba en la penumbra.' },
    ],
  });
  assert.equal(repeatRes.status, 200);
  const repeatData = await repeatRes.json();
  assert.deepEqual(repeatData.imported, []);
  assert.deepEqual(repeatData.unchanged, ['scenes/escena-01.md']);

  // 2. Overwrite refusal: importing existing scene with different text refuses with 409
  const overwriteRes = await api(`/books/${bookId}/import`, authorSession, {
    files: [
      { name: 'escena-01.md', content: '# Escena 1\nTexto completamente modificado sin propuesta.' },
    ],
  });
  assert.equal(overwriteRes.status, 409);
  const overwriteData = await overwriteRes.json();
  assert.match(overwriteData.error, /already exists with different text; edit it through a proposal/);

  // 3. Oversize refusal: uploading a file larger than 2 MB is refused
  const bigContent = 'x'.repeat(2 * 1024 * 1024 + 10);
  const oversizeRes = await api(`/books/${bookId}/import`, authorSession, {
    files: [
      { name: 'escena-03.md', content: bigContent },
    ],
  });
  assert.equal(oversizeRes.status, 413);

  // 4. Non-markdown refusal: files not ending in .md are rejected with 400
  const nonMdRes = await api(`/books/${bookId}/import`, authorSession, {
    files: [
      { name: 'notas.txt', content: 'Esto no es markdown' },
    ],
  });
  assert.equal(nonMdRes.status, 400);
  const nonMdData = await nonMdRes.json();
  assert.match(nonMdData.error, /Markdown/i);
});

test('navigate: list and read scenes, see pending proposals for a scene', async () => {
  const authorSession = await h.session('user_author3');
  const createRes = await api('/books', authorSession, { title: 'Navegación' });
  const bookId = (await createRes.json()).book_id;

  await api(`/books/${bookId}/import`, authorSession, {
    files: [
      { name: 'escena-01.md', content: '# Escena 1\nLa torre vigía dominaba el valle.' },
      { name: 'escena-02.md', content: '# Escena 2\nEl mensajero cruzó el puente.' },
    ],
  });

  // List scenes
  const scenesRes = await api(`/books/${bookId}/scenes`, authorSession);
  assert.equal(scenesRes.status, 200);
  const scenesData = await scenesRes.json();
  assert.deepEqual(scenesData.scenes, ['scenes/escena-01.md', 'scenes/escena-02.md']);

  // Read scene
  const readRes = await api(`/books/${bookId}/scenes/escena-01.md`, authorSession);
  assert.equal(readRes.status, 200);
  const readData = await readRes.json();
  assert.equal(readData.file, 'scenes/escena-01.md');
  assert.equal(readData.text, '# Escena 1\nLa torre vigía dominaba el valle.');
  assert.deepEqual(readData.proposals, []);

  // Propose a change to escena-01.md
  const bookDir = `${h.data}/books/${bookId}`;
  const propRes = cli('propose', bookDir, '--file', 'scenes/escena-01.md', '--find', 'La torre vigía', '--replace', 'El viejo torreón', '--rationale', 'nombre más evocador');
  assert.equal(propRes.code, 0);

  // Reading the scene now reveals the pending proposal
  const readWithPropRes = await api(`/books/${bookId}/scenes/escena-01.md`, authorSession);
  assert.equal(readWithPropRes.status, 200);
  const readWithPropData = await readWithPropRes.json();
  assert.equal(readWithPropData.proposals.length, 1);
  assert.equal(readWithPropData.proposals[0].proposal.file, 'scenes/escena-01.md');
  assert.equal(readWithPropData.proposals[0].applicable, true);

  // Scene 2 has no pending proposals
  const readScene2Res = await api(`/books/${bookId}/scenes/escena-02.md`, authorSession);
  assert.equal(readScene2Res.status, 200);
  assert.equal((await readScene2Res.json()).proposals.length, 0);

  // Reading a non-existent scene returns 404
  const missingSceneRes = await api(`/books/${bookId}/scenes/no-existe.md`, authorSession);
  assert.equal(missingSceneRes.status, 404);
});

test('cross-book refusal for another subject across all workspace endpoints', async () => {
  const authorSession = await h.session('user_author4');
  const strangerSession = await h.session('user_stranger4');
  const createRes = await api('/books', authorSession, { title: 'Secreto del autor' });
  const bookId = (await createRes.json()).book_id;

  await api(`/books/${bookId}/import`, authorSession, {
    files: [{ name: 'escena-01.md', content: 'Texto confidencial' }],
  });

  // Stranger cannot import into author's book
  const strangerImport = await api(`/books/${bookId}/import`, strangerSession, {
    files: [{ name: 'inyeccion.md', content: 'Intrusión' }],
  });
  assert.equal(strangerImport.status, 404);

  // Stranger cannot list scenes
  const strangerScenes = await api(`/books/${bookId}/scenes`, strangerSession);
  assert.equal(strangerScenes.status, 404);

  // Stranger cannot read scenes
  const strangerRead = await api(`/books/${bookId}/scenes/escena-01.md`, strangerSession);
  assert.equal(strangerRead.status, 404);
});

test('import rejects batch with duplicate basenames (400 naming duplicate, nothing written)', async () => {
  const authorSession = await h.session('user_author5');
  const createRes = await api('/books', authorSession, { title: 'Collision Test Book' });
  const bookId = (await createRes.json()).book_id;

  const res = await api(`/books/${bookId}/import`, authorSession, {
    files: [
      { name: 'chapter1/scene-01.md', content: 'Text of Chapter 1' },
      { name: 'chapter2/scene-01.md', content: 'Text of Chapter 2' },
    ],
  });

  assert.equal(res.status, 400);
  const data = await res.json();
  assert.match(data.error, /duplicate/i);
  assert.match(data.error, /scene-01\.md/);

  // Verify nothing was written
  const scenesRes = await api(`/books/${bookId}/scenes`, authorSession);
  const scenesData = await scenesRes.json();
  assert.deepEqual(scenesData.scenes, []);
});

test('import is all-or-nothing: mixed batch with conflict writes nothing (409)', async () => {
  const authorSession = await h.session('user_author6');
  const createRes = await api('/books', authorSession, { title: 'Partial Write Book' });
  const bookId = (await createRes.json()).book_id;

  // Import an initial scene
  const initialRes = await api(`/books/${bookId}/import`, authorSession, {
    files: [{ name: 'existing-scene.md', content: 'Initial committed text' }],
  });
  assert.equal(initialRes.status, 200);

  // Attempt batch with a new scene and a conflicting scene
  const batchRes = await api(`/books/${bookId}/import`, authorSession, {
    files: [
      { name: 'new-scene.md', content: 'New scene text' },
      { name: 'existing-scene.md', content: 'Conflicting modified text' },
    ],
  });
  assert.equal(batchRes.status, 409);

  // Verify new-scene.md was NOT written to disk and cannot be read
  const readRes = await api(`/books/${bookId}/scenes/new-scene.md`, authorSession);
  assert.equal(readRes.status, 404);

  const scenesRes = await api(`/books/${bookId}/scenes`, authorSession);
  const scenesData = await scenesRes.json();
  assert.deepEqual(scenesData.scenes, ['scenes/existing-scene.md']);
});

test('import validates filenames before staging: rejects .md, leading dot, NUL, long names with 400 and no path disclosure', async () => {
  const authorSession = await h.session('user_author7');
  const createRes = await api('/books', authorSession, { title: 'Validation Book' });
  const bookId = (await createRes.json()).book_id;

  // 1. Bare .md
  const bareRes = await api(`/books/${bookId}/import`, authorSession, {
    files: [{ name: '.md', content: '# Bare dot md' }],
  });
  assert.equal(bareRes.status, 400);
  const bareData = await bareRes.json();
  assert.ok(!bareData.error.includes('/tmp'));

  // 2. Leading dot
  const hiddenRes = await api(`/books/${bookId}/import`, authorSession, {
    files: [{ name: '.hidden.md', content: '# Hidden' }],
  });
  assert.equal(hiddenRes.status, 400);
  const hiddenData = await hiddenRes.json();
  assert.ok(!hiddenData.error.includes('/tmp'));

  // 3. NUL byte
  const nulRes = await api(`/books/${bookId}/import`, authorSession, {
    files: [{ name: 'scene\0.md', content: '# Nul' }],
  });
  assert.equal(nulRes.status, 400);
  const nulData = await nulRes.json();
  assert.ok(!nulData.error.includes('/tmp'));

  // 4. Filename > 255 bytes
  const longName = 'a'.repeat(255) + '.md';
  const longRes = await api(`/books/${bookId}/import`, authorSession, {
    files: [{ name: longName, content: '# Long' }],
  });
  assert.equal(longRes.status, 400);
  const longData = await longRes.json();
  assert.ok(!longData.error.includes('/tmp'));

  // Verify nothing was written to the book
  const scenesRes = await api(`/books/${bookId}/scenes`, authorSession);
  const scenesData = await scenesRes.json();
  assert.deepEqual(scenesData.scenes, []);
});

test('book name collisions are neutral and identical for members and strangers', async () => {
  const owner = await h.session('user_fran');
  const stranger = await h.session('user_stranger');
  const beforeOwner = await (await api('/books', owner)).json();
  const beforeStranger = await (await api('/books', stranger)).json();
  const responses = [];
  for (const token of [owner, stranger]) {
    const res = await api('/books', token, { title: 'Sal', slug: 'sal' });
    assert.equal(res.status, 409);
    const body = await res.json();
    assert.equal(body.error, 'Ese nombre de libro no está disponible; elige otro título.');
    assert.equal(body.detail, body.error);
    assert.ok(!JSON.stringify(body).includes('sal'));
    responses.push(body);
  }
  assert.deepEqual(responses[0], responses[1]);
  assert.deepEqual(await (await api('/books', owner)).json(), beforeOwner);
  assert.deepEqual(await (await api('/books', stranger)).json(), beforeStranger);
});
