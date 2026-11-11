import assert from 'node:assert/strict';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';
import { cli, FIXTURES, git, read } from './helpers.ts';
import { proposeRevision, reviewApi, startHarness, type Harness } from './server-helpers.ts';

const SCENE = 'scenes/escena-01.md';
let h: Harness;

beforeEach(async () => {
  h = await startHarness();
  cli('extract', h.bookDir, '--from', join(FIXTURES, 'annotations.json'));
});

afterEach(() => h?.close());

const head = () => git(h.bookDir, 'rev-parse', 'HEAD');
const subject = () => git(h.bookDir, 'log', '-1', '--format=%s');
const bytes = () => readFileSync(join(h.bookDir, SCENE));

async function accept(session: string, id: string) {
  const res = await reviewApi(h, `/books/sal/proposals/${id}`, session, { decision: 'accept' });
  assert.equal(res.status, 200, await res.clone().text());
}

async function revert(session: string, id: string, expected: number) {
  return reviewApi(h, `/books/sal/proposals/${id}/revert`, session, { expected });
}

test('reverting an accepted change creates an inverse proposal, and only its acceptance restores the text byte for byte', async () => {
  const session = await h.session();
  const original = bytes();
  const id = proposeRevision(h.bookDir, SCENE, 'Fuera empezaba a llover', 'Fuera seguía lloviendo');
  await accept(session, id);
  const changed = bytes();
  const headBefore = head();

  const res = await revert(session, id, 1);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.created, true);
  const inverse = body.proposal;
  assert.equal(inverse.reverts, id);
  assert.equal(inverse.status, 'proposed');
  assert.equal(inverse.proposed_by, 'user_fran');
  assert.deepEqual(bytes(), changed, 'creating the inverse proposal writes no text');
  assert.equal(git(h.bookDir, 'rev-list', '--count', `${headBefore}..HEAD`), '1');
  assert.equal(subject(), `rewrite: propose ${inverse.proposal_id} to revert ${id}`);

  const shown = cli('show', h.bookDir, inverse.proposal_id).json;
  assert.equal(shown.applicable, true);
  assert.match(shown.diff, /^-.*Fuera seguía lloviendo/m);
  assert.match(shown.diff, /^\+.*Fuera empezaba a llover/m);
  const original_ = cli('show', h.bookDir, id).json.proposal;
  assert.equal(original_.status, 'accepted');
  assert.deepEqual(
    original_.history.map((e: any) => [e.from, e.to, e.action ?? null, e.ref ?? null]),
    [['proposed', 'accepted', null, null], ['accepted', 'accepted', 'revert', inverse.proposal_id]],
  );

  await accept(session, inverse.proposal_id);
  assert.deepEqual(bytes(), original);
});

test('a revert keeps later edits elsewhere in the scene', async () => {
  const session = await h.session();
  const id = proposeRevision(h.bookDir, SCENE, 'Fuera empezaba a llover', 'Fuera seguía lloviendo');
  await accept(session, id);
  const later = proposeRevision(h.bookDir, SCENE, 'El guardia escupió', 'El guardia carraspeó');
  await accept(session, later);

  const inverse = (await (await revert(session, id, 1)).json()).proposal;
  await accept(session, inverse.proposal_id);
  const text = read(h.bookDir, SCENE);
  assert.ok(text.includes('El guardia carraspeó'));
  assert.ok(text.includes('Fuera empezaba a llover sobre el puente.'));
  assert.ok(!text.includes('Fuera seguía lloviendo'));
});

test('a revert that later edits made incompatible is refused, and nothing is written', async () => {
  const session = await h.session();
  const id = proposeRevision(h.bookDir, SCENE, 'Fuera empezaba a llover', 'Fuera seguía lloviendo');
  await accept(session, id);
  const later = proposeRevision(h.bookDir, SCENE, 'Fuera seguía lloviendo', 'Fuera ya no llovía');
  await accept(session, later);
  const headBefore = head();

  const res = await revert(session, id, 1);
  assert.equal(res.status, 409);
  assert.match((await res.json()).error, /ediciones posteriores/);
  assert.equal(head(), headBefore);
  assert.equal(cli('show', h.bookDir, id).json.proposal.history.length, 1);
});

test('a deletion is reverted by anchoring on the text around it', async () => {
  const session = await h.session();
  const original = bytes();
  const id = proposeRevision(h.bookDir, SCENE, ' sobre el puente.', '.');
  await accept(session, id);
  const inverse = (await (await revert(session, id, 1)).json()).proposal;
  await accept(session, inverse.proposal_id);
  assert.deepEqual(bytes(), original);
});

test('repeating a revert returns the same inverse proposal, a stale tab is refused, and a rejected inverse is reopened', async () => {
  const session = await h.session();
  const id = proposeRevision(h.bookDir, SCENE, 'Fuera empezaba a llover', 'Fuera seguía lloviendo');
  await accept(session, id);
  const first = (await (await revert(session, id, 1)).json()).proposal;
  const headAfter = head();

  const repeat = await revert(session, id, 1);
  assert.equal(repeat.status, 200);
  const again = await repeat.json();
  assert.equal(again.created, false);
  assert.equal(again.proposal.proposal_id, first.proposal_id);
  assert.equal(head(), headAfter);

  const stale = await revert(session, id, 0);
  assert.equal(stale.status, 409);
  assert.match((await stale.json()).error, /otra pestaña/);

  await reviewApi(h, `/books/sal/proposals/${first.proposal_id}`, session, { decision: 'reject' });
  const reopened = await revert(session, id, 2);
  assert.equal(reopened.status, 200);
  const third = (await reopened.json()).proposal;
  assert.equal(third.proposal_id, first.proposal_id);
  assert.equal(third.status, 'proposed');
  assert.deepEqual(third.history.map((e: any) => [e.from, e.to, e.action ?? null]), [['proposed', 'rejected', null], ['rejected', 'proposed', 'reopen']]);
  assert.equal(cli('show', h.bookDir, id).json.proposal.history.length, 3);
});

test('only an accepted proposal can be reverted', async () => {
  const session = await h.session();
  const id = proposeRevision(h.bookDir, SCENE, 'Fuera empezaba a llover', 'Fuera seguía lloviendo');
  const headBefore = head();
  const pending = await revert(session, id, 0);
  assert.equal(pending.status, 409);
  assert.match((await pending.json()).error, /only an accepted/);
  assert.equal((await reviewApi(h, `/books/sal/proposals/${id}/revert`, session, {})).status, 400);
  assert.equal((await revert(session, 'P-none', 0)).status, 409);
  assert.equal(head(), headBefore);
});

test('after a revert the change can be proposed again against the current text', async () => {
  const session = await h.session();
  const id = proposeRevision(h.bookDir, SCENE, 'Fuera empezaba a llover', 'Fuera seguía lloviendo');
  await accept(session, id);
  const inverse = (await (await revert(session, id, 1)).json()).proposal;
  await accept(session, inverse.proposal_id);
  const headBefore = head();

  const res = await reviewApi(h, `/books/sal/proposals/${id}/repropose`, session, {});
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.created, true);
  const again = body.proposal;
  assert.notEqual(again.proposal_id, id);
  assert.equal(again.reproposes, id);
  assert.equal(again.find, 'Fuera empezaba a llover');
  assert.equal(again.replace, 'Fuera seguía lloviendo');
  assert.equal(again.proposed_by, 'user_fran');
  assert.equal(subject(), `rewrite: propose ${again.proposal_id} again from ${id}`);
  assert.equal(git(h.bookDir, 'rev-list', '--count', `${headBefore}..HEAD`), '1');
  assert.equal(cli('show', h.bookDir, again.proposal_id).json.applicable, true);

  await accept(session, again.proposal_id);
  assert.ok(read(h.bookDir, SCENE).includes('Fuera seguía lloviendo'));
});

test('proposing again is refused when the text no longer contains the passage', async () => {
  const session = await h.session();
  const id = proposeRevision(h.bookDir, SCENE, 'Fuera empezaba a llover', 'Fuera seguía lloviendo');
  await accept(session, id);
  const headBefore = head();
  const res = await reviewApi(h, `/books/sal/proposals/${id}/repropose`, session, {});
  assert.equal(res.status, 409);
  assert.match((await res.json()).error, /not found/);
  assert.equal(head(), headBefore);
});

test('revert and repropose are review actions: agent tokens are refused', async () => {
  const agent = await h.access();
  assert.equal((await reviewApi(h, '/books/sal/proposals/P-0000000000/revert', agent, { expected: 1 })).status, 401);
  assert.equal((await reviewApi(h, '/books/sal/proposals/P-0000000000/repropose', agent, {})).status, 401);
  const session = await h.session();
  assert.equal((await reviewApi(h, '/books/sal/claims/C-0000000000/revert', session, { expected: 1 })).status, 404);
});

test('proposal ids of ordinary proposals do not change; only a proposal made again hashes its origin', async () => {
  const { proposalId } = await import('../src/domain/proposal.ts');
  const { shortHash } = await import('../src/domain/claim.ts');
  assert.equal(proposalId('scenes/a.md', 'b', 'x', 'y'), shortHash('P-', 'scenes/a.md', 'b', 'x', 'y'));
  assert.notEqual(proposalId('scenes/a.md', 'b', 'x', 'y', 'P-1'), proposalId('scenes/a.md', 'b', 'x', 'y'));
});

test('a revert or repropose whose commit fails writes nothing, and a retry works', async () => {
  const session = await h.session();
  const id = proposeRevision(h.bookDir, SCENE, 'Fuera empezaba a llover', 'Fuera seguía lloviendo');
  await accept(session, id);
  const state = () => git(h.bookDir, 'status', '--porcelain', '--untracked-files=all') + readFileSync(join(h.bookDir, '.rewrite', 'proposals', `${id}.json`), 'utf8');
  const before = state();
  const headBefore = head();
  const lock = join(h.bookDir, '.git', 'index.lock');

  writeFileSync(lock, '');
  assert.equal((await revert(session, id, 1)).status, 409);
  rmSync(lock);
  assert.equal(state(), before);
  assert.equal(head(), headBefore);

  const inverse = (await (await revert(session, id, 1)).json()).proposal;
  await accept(session, inverse.proposal_id);
  const afterRevert = git(h.bookDir, 'status', '--porcelain', '--untracked-files=all');
  writeFileSync(lock, '');
  assert.equal((await reviewApi(h, `/books/sal/proposals/${id}/repropose`, session, {})).status, 409);
  rmSync(lock);
  assert.equal(git(h.bookDir, 'status', '--porcelain', '--untracked-files=all'), afterRevert);
  assert.equal((await reviewApi(h, `/books/sal/proposals/${id}/repropose`, session, {})).status, 200);
});
