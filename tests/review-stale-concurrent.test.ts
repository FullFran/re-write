import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';
import { cli, FIXTURES, git } from './helpers.ts';
import { proposeRevision, reviewApi, startHarness, type Harness } from './server-helpers.ts';

const SCENE = 'scenes/escena-01.md';
let h: Harness;

beforeEach(async () => {
  h = await startHarness();
  cli('extract', h.bookDir, '--from', join(FIXTURES, 'annotations.json'));
});

afterEach(() => {
  h?.close();
});

test('two competing accepts of different proposals on the same scene text', async () => {
  const session = await h.session();
  const scenePath = join(h.bookDir, SCENE);
  const originalBytes = readFileSync(scenePath);

  // Two competing proposals on the exact same sentence in escena-01.md
  const findText = 'Fuera empezaba a llover';
  const replaceA = 'Fuera arreciaba la tormenta';
  const replaceB = 'Fuera el cielo permanecía despejado';
  const idA = proposeRevision(h.bookDir, SCENE, findText, replaceA, 'primera opción de estilo');
  const idB = proposeRevision(h.bookDir, SCENE, findText, replaceB, 'segunda opción de estilo');

  assert.equal(cli('show', h.bookDir, idA).json.applicable, true);
  assert.equal(cli('show', h.bookDir, idB).json.applicable, true);

  const headBeforeAccept = git(h.bookDir, 'rev-parse', 'HEAD');

  // Competing accepts sent concurrently
  const [resA, resB] = await Promise.all([
    reviewApi(h, `/books/sal/proposals/${idA}`, session, { decision: 'accept', note: 'preferida tormenta' }),
    reviewApi(h, `/books/sal/proposals/${idB}`, session, { decision: 'accept', note: 'preferido despejado' }),
  ]);

  const bodyA = await resA.json();
  const bodyB = await resB.json();

  // Exactly one wins (HTTP 200) and the other is refused as stale conflict (HTTP 409)
  const winner = resA.status === 200
    ? { id: idA, res: resA, body: bodyA, replace: replaceA, note: 'preferida tormenta' }
    : { id: idB, res: resB, body: bodyB, replace: replaceB, note: 'preferido despejado' };
  const loser = resA.status === 409
    ? { id: idA, res: resA, body: bodyA, replace: replaceA, note: 'preferida tormenta' }
    : { id: idB, res: resB, body: bodyB, replace: replaceB, note: 'preferido despejado' };

  // 1. Assert HTTP status and body
  assert.equal(winner.res.status, 200);
  assert.equal(winner.body.changed, true);
  assert.equal(winner.body.proposal.proposal_id, winner.id);
  assert.equal(winner.body.proposal.status, 'accepted');

  assert.equal(loser.res.status, 409);
  assert.equal(loser.body.status, 409);
  assert.equal(loser.body.type, 'https://github.com/FullFran/re-write/blob/main/docs/problems.md#stale-evidence');
  assert.equal(loser.body.detail, `${SCENE} changed since proposal ${loser.id} was made; nothing was written`);
  assert.equal(loser.body.error, loser.body.detail);

  // 2. Assert scene file bytes on disk
  const textAfterAccept = readFileSync(scenePath, 'utf8');
  assert.ok(textAfterAccept.includes(winner.replace));
  assert.ok(!textAfterAccept.includes(loser.replace));
  assert.ok(!textAfterAccept.includes(findText));

  // 3. Assert git history: exactly ONE commit added for accept
  const headAfterAccept = git(h.bookDir, 'rev-parse', 'HEAD');
  assert.notEqual(headAfterAccept, headBeforeAccept);
  assert.equal(git(h.bookDir, 'rev-list', '--count', `${headBeforeAccept}..HEAD`), '1');
  assert.equal(git(h.bookDir, 'log', '-1', '--format=%s'), `rewrite: accept ${winner.id}`);
  assert.equal(git(h.bookDir, 'show', `${headBeforeAccept}:${SCENE}`), originalBytes.toString('utf8').trim());

  // 4. Assert proposal states
  const winnerShown = cli('show', h.bookDir, winner.id).json;
  assert.equal(winnerShown.proposal.status, 'accepted');
  assert.equal(winnerShown.proposal.result_commit, headAfterAccept);
  assert.equal(winnerShown.proposal.history[0].by, 'user_fran');
  assert.equal(winnerShown.proposal.history[0].to, 'accepted');

  const loserShown = cli('show', h.bookDir, loser.id).json;
  assert.equal(loserShown.proposal.status, 'proposed');
  assert.equal(loserShown.applicable, false);
  assert.equal(loserShown.proposal.history.length, 0);

  // 5. Reject must leave the source byte-identical
  const bytesBeforeReject = readFileSync(scenePath);
  const rejectRes = await reviewApi(h, `/books/sal/proposals/${loser.id}`, session, {
    decision: 'reject',
    note: 'rechazada por conflicto con la propuesta ganadora',
  });
  assert.equal(rejectRes.status, 200);
  const rejectBody = await rejectRes.json();
  assert.equal(rejectBody.changed, true);
  assert.equal(rejectBody.proposal.status, 'rejected');

  const bytesAfterReject = readFileSync(scenePath);
  assert.deepEqual(bytesAfterReject, bytesBeforeReject);
  assert.equal(git(h.bookDir, 'diff', headAfterAccept, 'HEAD', '--', 'scenes'), '');
  assert.equal(cli('show', h.bookDir, loser.id).json.proposal.status, 'rejected');
});

test('a stale proposal whose source was changed by an accepted proposal (committed)', async () => {
  const session = await h.session();
  const scenePath = join(h.bookDir, SCENE);

  // Proposal 1 will be accepted and committed first
  const id1 = proposeRevision(h.bookDir, SCENE, 'Fuera empezaba a llover', 'Fuera llovía con calma');
  // Proposal 2 is created against the same initial revision on another line
  const id2 = proposeRevision(h.bookDir, SCENE, 'El guardia no preguntó', 'El guardia permaneció mudo');

  assert.equal(cli('show', h.bookDir, id1).json.applicable, true);
  assert.equal(cli('show', h.bookDir, id2).json.applicable, true);

  const headBeforeAccept1 = git(h.bookDir, 'rev-parse', 'HEAD');

  // Accept proposal 1
  const res1 = await reviewApi(h, `/books/sal/proposals/${id1}`, session, { decision: 'accept', note: 'aceptar primera' });
  assert.equal(res1.status, 200);
  const headAfter1 = git(h.bookDir, 'rev-parse', 'HEAD');
  assert.notEqual(headAfter1, headBeforeAccept1);
  assert.equal(git(h.bookDir, 'rev-list', '--count', `${headBeforeAccept1}..HEAD`), '1');

  const bytesAfter1 = readFileSync(scenePath);
  assert.ok(bytesAfter1.toString('utf8').includes('Fuera llovía con calma'));

  // Proposal 2 is now stale because its source file was committed with a new revision
  const shown2Before = cli('show', h.bookDir, id2).json;
  assert.equal(shown2Before.applicable, false);
  assert.equal(shown2Before.proposal.status, 'proposed');

  // Attempt to accept stale proposal 2
  const res2 = await reviewApi(h, `/books/sal/proposals/${id2}`, session, { decision: 'accept' });
  const body2 = await res2.json();

  // 1. Assert HTTP status and body
  assert.equal(res2.status, 409);
  assert.equal(body2.status, 409);
  assert.equal(body2.type, 'https://github.com/FullFran/re-write/blob/main/docs/problems.md#stale-evidence');
  assert.equal(body2.detail, `${SCENE} changed since proposal ${id2} was made; nothing was written`);
  assert.equal(body2.error, body2.detail);

  // 2. Assert scene file bytes on disk are untouched by the refused accept
  assert.deepEqual(readFileSync(scenePath), bytesAfter1);
  assert.ok(!readFileSync(scenePath, 'utf8').includes('El guardia permaneció mudo'));

  // 3. Assert git history is unchanged by the refused accept
  assert.equal(git(h.bookDir, 'rev-parse', 'HEAD'), headAfter1);
  assert.equal(git(h.bookDir, 'rev-list', '--count', `${headBeforeAccept1}..HEAD`), '1');

  // 4. Assert proposal 2 state remains proposed and unapplied
  const shown2AfterAccept = cli('show', h.bookDir, id2).json;
  assert.equal(shown2AfterAccept.proposal.status, 'proposed');
  assert.equal(shown2AfterAccept.applicable, false);
  assert.equal(shown2AfterAccept.proposal.history.length, 0);

  // 5. Reject must leave the source byte-identical
  const rejectRes2 = await reviewApi(h, `/books/sal/proposals/${id2}`, session, {
    decision: 'reject',
    note: 'descartada porque la escena cambió',
  });
  assert.equal(rejectRes2.status, 200);
  const rejectBody2 = await rejectRes2.json();
  assert.equal(rejectBody2.changed, true);
  assert.equal(rejectBody2.proposal.status, 'rejected');

  assert.deepEqual(readFileSync(scenePath), bytesAfter1);
  assert.equal(git(h.bookDir, 'diff', headAfter1, 'HEAD', '--', 'scenes'), '');
  assert.equal(cli('show', h.bookDir, id2).json.proposal.status, 'rejected');
});

test('a stale proposal whose scene file was edited on disk but not committed', async () => {
  const session = await h.session();
  const scenePath = join(h.bookDir, SCENE);
  const originalBytes = readFileSync(scenePath);

  const id = proposeRevision(h.bookDir, SCENE, 'Fuera empezaba a llover', 'Fuera caía aguanieve');
  assert.equal(cli('show', h.bookDir, id).json.applicable, true);

  const headBeforeDiskEdit = git(h.bookDir, 'rev-parse', 'HEAD');

  // Author edits scene file on disk without committing
  const uncommittedModification = '\n<!-- borrador local no confirmado -->\n';
  const uncommittedBytes = Buffer.from(originalBytes.toString('utf8') + uncommittedModification, 'utf8');
  writeFileSync(scenePath, uncommittedBytes);

  // Dirty working tree, git HEAD unchanged
  assert.notEqual(git(h.bookDir, 'status', '--porcelain', '--', SCENE), '');
  assert.equal(git(h.bookDir, 'rev-parse', 'HEAD'), headBeforeDiskEdit);
  assert.equal(cli('show', h.bookDir, id).json.applicable, false);

  // Reviewer attempts to accept proposal via HTTP
  const res = await reviewApi(h, `/books/sal/proposals/${id}`, session, { decision: 'accept' });
  const body = await res.json();

  // 1. Assert HTTP status and body
  assert.equal(res.status, 409);
  assert.equal(body.status, 409);
  assert.equal(body.type, 'https://github.com/FullFran/re-write/blob/main/docs/problems.md#stale-evidence');
  assert.equal(body.detail, `${SCENE} changed since proposal ${id} was made; nothing was written`);
  assert.equal(body.error, body.detail);

  // 2. Assert scene file bytes on disk preserve uncommitted edits byte-for-byte
  assert.deepEqual(readFileSync(scenePath), uncommittedBytes);
  assert.ok(!readFileSync(scenePath, 'utf8').includes('Fuera caía aguanieve'));

  // 3. Assert git history is untouched
  assert.equal(git(h.bookDir, 'rev-parse', 'HEAD'), headBeforeDiskEdit);
  assert.equal(git(h.bookDir, 'rev-list', '--count', `${headBeforeDiskEdit}..HEAD`), '0');

  // 4. Assert proposal state
  const shown = cli('show', h.bookDir, id).json;
  assert.equal(shown.proposal.status, 'proposed');
  assert.equal(shown.applicable, false);
  assert.equal(shown.proposal.history.length, 0);

  // 5. Reject must leave the source byte-identical
  const rejectRes = await reviewApi(h, `/books/sal/proposals/${id}`, session, {
    decision: 'reject',
    note: 'rechazada mientras hay edición local en curso',
  });
  assert.equal(rejectRes.status, 200);
  const rejectBody = await rejectRes.json();
  assert.equal(rejectBody.changed, true);
  assert.equal(rejectBody.proposal.status, 'rejected');

  // Source on disk remains completely identical to the uncommitted state
  assert.deepEqual(readFileSync(scenePath), uncommittedBytes);
  // git status still shows the scene file as locally modified, and the reject commit only touched .rewrite
  assert.notEqual(git(h.bookDir, 'status', '--porcelain', '--', SCENE), '');
  assert.ok(git(h.bookDir, 'diff', 'HEAD', '--', SCENE).includes('<!-- borrador local no confirmado -->'));
  assert.equal(cli('show', h.bookDir, id).json.proposal.status, 'rejected');
});

test('the same proposal accepted twice concurrently (Promise.all)', async () => {
  const session = await h.session();
  const scenePath = join(h.bookDir, SCENE);
  const originalBytes = readFileSync(scenePath);

  const findText = 'El guardia no preguntó';
  const replaceText = 'El guardia no dijo una sola palabra';
  const id = proposeRevision(h.bookDir, SCENE, findText, replaceText, 'unificar actitud del guardia');

  assert.equal(cli('show', h.bookDir, id).json.applicable, true);

  const headBeforeAccept = git(h.bookDir, 'rev-parse', 'HEAD');

  // Accept the same proposal twice concurrently
  const [res1, res2] = await Promise.all([
    reviewApi(h, `/books/sal/proposals/${id}`, session, { decision: 'accept', note: 'primer clic' }),
    reviewApi(h, `/books/sal/proposals/${id}`, session, { decision: 'accept', note: 'segundo clic concurrente' }),
  ]);

  const body1 = await res1.json();
  const body2 = await res2.json();

  // 1. Assert HTTP status and body
  assert.equal(res1.status, 200);
  assert.equal(res2.status, 200);
  const changedFlags = [body1.changed, body2.changed].sort();
  assert.deepEqual(changedFlags, [false, true]);
  assert.equal(body1.proposal.proposal_id, id);
  assert.equal(body2.proposal.proposal_id, id);
  assert.equal(body1.proposal.status, 'accepted');
  assert.equal(body2.proposal.status, 'accepted');

  // 2. Assert scene file bytes on disk: change applied exactly once
  const textAfterAccept = readFileSync(scenePath, 'utf8');
  assert.ok(textAfterAccept.includes(replaceText));
  assert.ok(!textAfterAccept.includes(findText));
  const occurrences = textAfterAccept.split(replaceText).length - 1;
  assert.equal(occurrences, 1);

  // 3. Assert git history: exactly ONE commit created
  const headAfterAccept = git(h.bookDir, 'rev-parse', 'HEAD');
  assert.notEqual(headAfterAccept, headBeforeAccept);
  assert.equal(git(h.bookDir, 'rev-list', '--count', `${headBeforeAccept}..HEAD`), '1');
  assert.equal(git(h.bookDir, 'log', '-1', '--format=%s'), `rewrite: accept ${id}`);
  assert.equal(git(h.bookDir, 'show', `${headBeforeAccept}:${SCENE}`), originalBytes.toString('utf8').trim());

  // 4. Assert proposal state
  const shown = cli('show', h.bookDir, id).json;
  assert.equal(shown.proposal.status, 'accepted');
  assert.equal(shown.proposal.result_commit, headAfterAccept);
  // Only the first accept transitioned status, duplicate concurrent was idempotent no-op
  assert.equal(shown.proposal.history.length, 1);
  assert.equal(shown.proposal.history[0].to, 'accepted');

  // 5. Reject on already-accepted proposal is refused and leaves source byte-identical
  const bytesAfterAccept = readFileSync(scenePath);
  const rejectRes = await reviewApi(h, `/books/sal/proposals/${id}`, session, { decision: 'reject' });
  assert.equal(rejectRes.status, 409);
  const rejectBody = await rejectRes.json();
  assert.equal(rejectBody.status, 409);
  assert.equal(rejectBody.detail, 'this was already accepted');
  assert.equal(rejectBody.error, 'this was already accepted');

  // Source on disk and git history remain byte-identical
  assert.deepEqual(readFileSync(scenePath), bytesAfterAccept);
  assert.equal(git(h.bookDir, 'rev-parse', 'HEAD'), headAfterAccept);
  assert.equal(cli('show', h.bookDir, id).json.proposal.status, 'accepted');
});
