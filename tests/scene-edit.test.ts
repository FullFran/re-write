import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { decide, SCENE_EDIT } from '../src/application/decision.ts';
import { grantPermission } from '../src/hcs/grants.ts';
import { cli, FIXTURES, git, read } from './helpers.ts';
import { proposeRevision, reviewApi, startHarness, type Harness } from './server-helpers.ts';

const SCENE = 'scenes/escena-01.md';
let h: Harness;
before(async () => {
  h = await startHarness();
  cli('extract', h.bookDir, '--from', join(FIXTURES, 'annotations.json'));
});
after(() => h.close());

async function openScene(session: string, file = SCENE): Promise<{ text: string; blob: string }> {
  const res = await reviewApi(h, `/books/sal/scenes/${encodeURIComponent(file)}`, session);
  assert.equal(res.status, 200);
  return res.json();
}

function save(session: string | undefined, body: unknown, file = SCENE): Promise<Response> {
  return reviewApi(h, `/books/sal/scenes/${encodeURIComponent(file)}`, session, body);
}

function bytes(file = SCENE): Buffer {
  return readFileSync(join(h.bookDir, file));
}

test('a person saves their own edit: the exact text, in one commit that touches only the scene', async () => {
  const session = await h.session();
  const scene = await openScene(session);
  assert.equal(scene.blob, git(h.bookDir, 'hash-object', SCENE), 'reading a scene returns the version it is based on');
  const head = git(h.bookDir, 'rev-parse', 'HEAD');
  const text = scene.text.replace('empezaba a llover', 'empezaba a lloviznar') + '\n> Una cita *nueva* con **marcas**, «comillas» y — raya.\r\n';
  const res = await save(session, { base_blob: scene.blob, text });
  assert.equal(res.status, 200);
  const saved = await res.json();
  assert.equal(saved.changed, true);
  assert.equal(saved.file, SCENE);
  assert.deepEqual(bytes(), Buffer.from(text, 'utf8'), 'the scene is stored byte for byte as sent');
  assert.equal(saved.blob, git(h.bookDir, 'hash-object', SCENE));
  assert.equal(saved.revision, git(h.bookDir, 'rev-parse', 'HEAD'));
  assert.equal(git(h.bookDir, 'rev-parse', 'HEAD~1'), head, 'exactly one new commit');
  assert.equal(git(h.bookDir, 'diff', '--name-only', head, 'HEAD'), SCENE);
  assert.equal(git(h.bookDir, 'log', '-1', '--format=%s'), `rewrite: edit ${SCENE}`);
  assert.match(git(h.bookDir, 'log', '-1', '--format=%b'), /^Edited-by: user_fran$/m);
  assert.equal(git(h.bookDir, 'status', '--porcelain'), '');
  assert.equal((await openScene(session)).blob, saved.blob);
});

test('saving the same text changes nothing and makes no commit', async () => {
  const session = await h.session();
  const scene = await openScene(session);
  const head = git(h.bookDir, 'rev-parse', 'HEAD');
  const res = await save(session, { base_blob: scene.blob, text: scene.text });
  assert.equal(res.status, 200);
  const saved = await res.json();
  assert.equal(saved.changed, false);
  assert.equal(saved.blob, scene.blob);
  assert.equal(git(h.bookDir, 'rev-parse', 'HEAD'), head);
});

test('an edit based on an older version is refused with the current text, and nothing is written', async () => {
  const session = await h.session();
  const opened = await openScene(session);
  // While the person types, a proposal is accepted on the same scene.
  const id = proposeRevision(h.bookDir, SCENE, 'El guardia no preguntó', 'El guardia calló');
  assert.equal((await reviewApi(h, `/books/sal/proposals/${id}`, session, { decision: 'accept' })).status, 200);
  const accepted = bytes();
  const head = git(h.bookDir, 'rev-parse', 'HEAD');
  const res = await save(session, { base_blob: opened.blob, text: opened.text + 'Mi párrafo.\n' });
  assert.equal(res.status, 409);
  const body = await res.json();
  assert.match(body.error, /changed since you opened it/);
  assert.equal(body.current.text, accepted.toString('utf8'));
  assert.equal(body.current.blob, git(h.bookDir, 'hash-object', SCENE));
  assert.deepEqual(bytes(), accepted);
  assert.equal(git(h.bookDir, 'rev-parse', 'HEAD'), head);
  // A second tab saving over the version the first one just wrote is refused the same way.
  const fresh = await openScene(session);
  assert.equal((await save(session, { base_blob: fresh.blob, text: fresh.text + 'A.\n' })).status, 200);
  assert.equal((await save(session, { base_blob: fresh.blob, text: fresh.text + 'B.\n' })).status, 409);
  assert.ok(read(h.bookDir, SCENE).endsWith('A.\n'));
});

test('after a writer edit, proposals and evidence on the old text follow the existing staleness rules', async () => {
  const session = await h.session();
  const QUOTE = 'La llave está bajo la losa del altar';
  const id = proposeRevision(h.bookDir, SCENE, 'escupió sobre las losas', 'escupió en las losas');
  const scene = await openScene(session);
  assert.ok(scene.text.includes(QUOTE));
  const edited = scene.text.replace(QUOTE, 'Nadie sabe dónde está la llave');
  assert.equal((await save(session, { base_blob: scene.blob, text: edited })).status, 200);
  const queue = await (await reviewApi(h, '/books/sal', session)).json();
  const queued = queue.proposals.find((p: any) => p.proposal.proposal_id === id);
  assert.equal(queued.applicable, false, 'any edit to the scene makes its pending proposals not applicable');
  const refused = await reviewApi(h, `/books/sal/proposals/${id}`, session, { decision: 'accept' });
  assert.equal(refused.status, 409);
  assert.equal(read(h.bookDir, SCENE), edited);
  const claim = queue.claims.find((c: any) => c.anchor.quote === QUOTE);
  assert.equal(claim.evidence_status, 'orphaned');
});

test('text that cannot be stored faithfully is refused before anything is written', async () => {
  const session = await h.session();
  const scene = await openScene(session);
  const before = bytes();
  const head = git(h.bookDir, 'rev-parse', 'HEAD');
  const cases: [unknown, number, RegExp][] = [
    [{ base_blob: scene.blob, text: 'con\u0000nulo' }, 400, /NUL/],
    [{ base_blob: scene.blob, text: 'mitad \ud800 de un par' }, 400, /not valid Unicode/],
    [{ base_blob: scene.blob, text: 'ñ'.repeat(600_000) }, 400, /larger than 1048576 bytes/],
    [{ base_blob: scene.blob }, 400, /text and base_blob/],
    [{ text: 'x' }, 400, /text and base_blob/],
  ];
  for (const [body, status, error] of cases) {
    const res = await save(session, body);
    assert.equal(res.status, status);
    assert.match((await res.json()).error, error);
  }
  assert.deepEqual(bytes(), before);
  assert.equal(git(h.bookDir, 'rev-parse', 'HEAD'), head);
});

test('a scene that is not valid UTF-8 cannot be edited, so saving never rewrites bytes it could not read', async () => {
  const session = await h.session();
  const FILE = 'scenes/latin1.md';
  writeFileSync(join(h.bookDir, FILE), Buffer.from([0x45, 0x6c, 0x20, 0x6e, 0x69, 0xf1, 0x6f, 0x0a]));
  git(h.bookDir, 'add', FILE);
  git(h.bookDir, 'commit', '-q', '-m', 'latin1 scene', '--', FILE);
  const before = bytes(FILE);
  const scene = await openScene(session, FILE);
  const res = await save(session, { base_blob: scene.blob, text: scene.text + 'más\n' }, FILE);
  assert.equal(res.status, 409);
  assert.match((await res.json()).error, /not valid UTF-8/);
  assert.deepEqual(bytes(FILE), before);
});

test('only a person on the review door edits scenes: agents, packages and strangers cannot', async () => {
  const scene = await openScene(await h.session());
  const body = { base_blob: scene.blob, text: scene.text + 'intruso\n' };
  const before = bytes();
  assert.equal((await save(await h.access(), body)).status, 401, 'an agent token is refused by the review API');
  assert.equal((await save(await h.session('user_other'), body)).status, 404, 'a stranger gets the missing-book answer');
  assert.equal((await save(await h.session(), body, 'scenes/missing.md')).status, 404);
  assert.equal((await save(await h.session(), body, '../project.json')).status, 404);
  assert.deepEqual(bytes(), before);

  const request = { library: h.library, subject: 'user_fran', book: 'sal', permission: SCENE_EDIT };
  assert.deepEqual(decide({ ...request, door: 'review', entry: null }), { allow: true });
  assert.equal(decide({ ...request, door: 'mcp', entry: null }).allow, false, 'never through the MCP door');
  assert.equal(decide({ ...request, door: 'review', entry: 'com.example.package' }).allow, false, 'never by a package');
  assert.throws(() => grantPermission(h.data, 'com.example.package', SCENE_EDIT), /cannot be granted/);
});
