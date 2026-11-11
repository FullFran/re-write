import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';
import { Library } from '../src/application/library.ts';
import { decide } from '../src/application/decision.ts';
import { REVIEW_DECIDE } from '../src/hcs/ids.ts';
import { cli, FIXTURES, git, read } from './helpers.ts';
import { proposeRevision, reviewApi, startHarness, type Harness } from './server-helpers.ts';

const SCENE = 'scenes/escena-01.md';
let h: Harness;

beforeEach(async () => {
  h = await startHarness();
  cli('extract', h.bookDir, '--from', join(FIXTURES, 'annotations.json'));
});

afterEach(() => h?.close());

async function queue(session: string) {
  return (await reviewApi(h, '/books/sal', session)).json();
}

const head = () => git(h.bookDir, 'rev-parse', 'HEAD');
const subject = () => git(h.bookDir, 'log', '-1', '--format=%s');

test('a rejected proposal is reopened without touching the text, and can then be accepted', async () => {
  const session = await h.session();
  const id = proposeRevision(h.bookDir, SCENE, 'Fuera empezaba a llover', 'Fuera seguía lloviendo');
  await reviewApi(h, `/books/sal/proposals/${id}`, session, { decision: 'reject' });
  const before = read(h.bookDir, SCENE);
  const headBefore = head();

  const res = await reviewApi(h, `/books/sal/proposals/${id}/reopen`, session, { expected: 1, note: 'me equivoqué' });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.changed, true);
  assert.equal(body.proposal.status, 'proposed');
  assert.equal(read(h.bookDir, SCENE), before);
  assert.equal(git(h.bookDir, 'rev-list', '--count', `${headBefore}..HEAD`), '1');
  assert.equal(subject(), `rewrite: reopen ${id}`);
  const shown = cli('show', h.bookDir, id).json;
  assert.equal(shown.applicable, true);
  assert.deepEqual(
    shown.proposal.history.map((e: any) => [e.from, e.to, e.by, e.action ?? null]),
    [['proposed', 'rejected', 'user_fran', null], ['rejected', 'proposed', 'user_fran', 'reopen']],
  );
  assert.equal(shown.proposal.history[1].note, 'me equivoqué');

  const accept = await reviewApi(h, `/books/sal/proposals/${id}`, session, { decision: 'accept' });
  assert.equal(accept.status, 200);
  assert.ok(read(h.bookDir, SCENE).includes('Fuera seguía lloviendo'));
  assert.equal(cli('show', h.bookDir, id).json.proposal.history.length, 3);
});

test('an accepted proposal cannot be reopened, because its text already changed', async () => {
  const session = await h.session();
  const id = proposeRevision(h.bookDir, SCENE, 'Fuera empezaba a llover', 'Fuera seguía lloviendo');
  await reviewApi(h, `/books/sal/proposals/${id}`, session, { decision: 'accept' });
  const headBefore = head();
  const res = await reviewApi(h, `/books/sal/proposals/${id}/reopen`, session, { expected: 1 });
  assert.equal(res.status, 409);
  assert.match((await res.json()).error, /revert/);
  assert.equal(head(), headBefore);
  assert.equal(cli('show', h.bookDir, id).json.proposal.status, 'accepted');
});

test('a reopened proposal whose scene changed meanwhile stays pending but cannot be accepted', async () => {
  const session = await h.session();
  const id = proposeRevision(h.bookDir, SCENE, 'Fuera empezaba a llover', 'Fuera seguía lloviendo');
  await reviewApi(h, `/books/sal/proposals/${id}`, session, { decision: 'reject' });
  const other = proposeRevision(h.bookDir, SCENE, 'El guardia no preguntó', 'El guardia calló');
  await reviewApi(h, `/books/sal/proposals/${other}`, session, { decision: 'accept' });

  assert.equal((await reviewApi(h, `/books/sal/proposals/${id}/reopen`, session, { expected: 1 })).status, 200);
  const shown = (await queue(session)).proposals.find((p: any) => p.proposal.proposal_id === id);
  assert.equal(shown.proposal.status, 'proposed');
  assert.equal(shown.applicable, false);
  const before = read(h.bookDir, SCENE);
  assert.equal((await reviewApi(h, `/books/sal/proposals/${id}`, session, { decision: 'accept' })).status, 409);
  assert.equal(read(h.bookDir, SCENE), before);
});

test('reopening an accepted claim takes it out of canon, and it can be decided again', async () => {
  const session = await h.session();
  const fact = (await queue(session)).claims.find((c: any) => c.epistemic_kind === 'narrated_fact' && c.evidence_status === 'valid');
  await reviewApi(h, `/books/sal/claims/${fact.claim_id}`, session, { decision: 'accept' });
  assert.ok((await queue(session)).canon.some((c: any) => c.claim_id === fact.claim_id));
  const scene = read(h.bookDir, fact.source_file);

  const res = await reviewApi(h, `/books/sal/claims/${fact.claim_id}/reopen`, session, { expected: 1 });
  assert.equal(res.status, 200);
  assert.equal(subject(), `rewrite: reopen claim ${fact.claim_id}`);
  assert.equal(read(h.bookDir, fact.source_file), scene);
  const after = await queue(session);
  const claim = after.claims.find((c: any) => c.claim_id === fact.claim_id);
  assert.equal(claim.editorial_status, 'proposed');
  assert.deepEqual(claim.history.map((e: any) => [e.from, e.to, e.action ?? null]), [['proposed', 'accepted', null], ['accepted', 'proposed', 'reopen']]);
  assert.ok(!after.canon.some((c: any) => c.claim_id === fact.claim_id));

  assert.equal((await reviewApi(h, `/books/sal/claims/${fact.claim_id}`, session, { decision: 'reject' })).status, 200);
  const final = (await queue(session)).claims.find((c: any) => c.claim_id === fact.claim_id);
  assert.equal(final.editorial_status, 'rejected');
  assert.equal(final.history.length, 3);
});

test('a reopened claim whose evidence went stale cannot be accepted again', async () => {
  const session = await h.session();
  const fact = (await queue(session)).claims.find((c: any) => c.epistemic_kind === 'narrated_fact' && c.evidence_status === 'valid');
  await reviewApi(h, `/books/sal/claims/${fact.claim_id}`, session, { decision: 'reject' });
  const path = join(h.bookDir, fact.source_file);
  writeFileSync(path, read(h.bookDir, fact.source_file).replace(fact.anchor.quote, 'texto distinto'));
  git(h.bookDir, 'commit', '-qam', 'edit');

  assert.equal((await reviewApi(h, `/books/sal/claims/${fact.claim_id}/reopen`, session, { expected: 1 })).status, 200);
  const accept = await reviewApi(h, `/books/sal/claims/${fact.claim_id}`, session, { decision: 'accept' });
  assert.equal(accept.status, 409);
  assert.match((await accept.json()).error, /evidence is/);
});

test('a finding verdict is reopened: the finding is pending again and the old verdict stays in its history', async () => {
  const session = await h.session();
  const finding = (await queue(session)).findings[0];
  await reviewApi(h, `/books/sal/findings/${finding.finding_id}`, session, { verdict: 'confirmed' });
  const given = (await queue(session)).findings[0].verdict;

  const res = await reviewApi(h, `/books/sal/findings/${finding.finding_id}/reopen`, session, { expected: given.at, note: 'otra vez' });
  assert.equal(res.status, 200);
  assert.equal(subject(), `rewrite: reopen finding ${finding.finding_id}`);
  assert.equal((await queue(session)).findings[0].verdict, undefined);

  await reviewApi(h, `/books/sal/findings/${finding.finding_id}`, session, { verdict: 'false_positive' });
  const verdict = (await queue(session)).findings[0].verdict;
  assert.equal(verdict.verdict, 'false_positive');
  assert.equal(verdict.reopened, undefined);
  assert.equal(verdict.history.length, 1);
  assert.equal(verdict.history[0].verdict, 'confirmed');
  assert.equal(verdict.history[0].reopened.by, 'user_fran');
  assert.equal(verdict.history[0].reopened.note, 'otra vez');
});

test('a reopen from a tab that saw an older state is refused, and a repeated click changes nothing', async () => {
  const session = await h.session();
  const id = proposeRevision(h.bookDir, SCENE, 'Fuera empezaba a llover', 'Fuera seguía lloviendo');
  await reviewApi(h, `/books/sal/proposals/${id}`, session, { decision: 'reject' });

  assert.equal((await reviewApi(h, `/books/sal/proposals/${id}/reopen`, session, { expected: 1 })).status, 200);
  const headAfter = head();
  const repeat = await reviewApi(h, `/books/sal/proposals/${id}/reopen`, session, { expected: 1 });
  assert.equal(repeat.status, 200);
  assert.equal((await repeat.json()).changed, false);
  assert.equal(head(), headAfter);

  await reviewApi(h, `/books/sal/proposals/${id}`, session, { decision: 'reject' });
  const stale = await reviewApi(h, `/books/sal/proposals/${id}/reopen`, session, { expected: 1 });
  assert.equal(stale.status, 409);
  assert.match((await stale.json()).error, /otra pestaña/);
  assert.equal(cli('show', h.bookDir, id).json.proposal.status, 'rejected');

  const finding = (await queue(session)).findings[0];
  await reviewApi(h, `/books/sal/findings/${finding.finding_id}`, session, { verdict: 'confirmed' });
  const staleFinding = await reviewApi(h, `/books/sal/findings/${finding.finding_id}/reopen`, session, { expected: '2000-01-01T00:00:00.000Z' });
  assert.equal(staleFinding.status, 409);
  assert.match((await staleFinding.json()).error, /otra pestaña/);
});

test('reopen needs the state the tab saw and something decided to reopen', async () => {
  const session = await h.session();
  const id = proposeRevision(h.bookDir, SCENE, 'Fuera empezaba a llover', 'Fuera seguía lloviendo');
  const headBefore = head();
  assert.equal((await reviewApi(h, `/books/sal/proposals/${id}/reopen`, session, {})).status, 400);
  const pending = await reviewApi(h, `/books/sal/proposals/${id}/reopen`, session, { expected: 0 });
  assert.equal(pending.status, 409);
  assert.match((await pending.json()).error, /not decided/);
  const finding = (await queue(session)).findings[0];
  assert.equal((await reviewApi(h, `/books/sal/findings/${finding.finding_id}/reopen`, session, { expected: 'x' })).status, 409);
  assert.equal((await reviewApi(h, '/books/sal/claims/C-none/reopen', session, { expected: 0 })).status, 409);
  assert.equal((await reviewApi(h, `/books/sal/proposals/${id}/other`, session, { expected: 0 })).status, 404);
  assert.equal(head(), headBefore);
});

test('reopen is a review action: agent tokens and package entries are refused', async () => {
  const agent = await h.access();
  for (const kind of ['claims', 'proposals', 'findings']) {
    assert.equal((await reviewApi(h, `/books/sal/${kind}/X-0000000000/reopen`, agent, { expected: 0 })).status, 401);
  }
  const library = new Library(h.data);
  const request = { library, subject: 'user_fran', book: 'sal', door: 'review' as const, permission: REVIEW_DECIDE };
  assert.deepEqual(decide({ ...request, entry: null }), { allow: true });
  assert.equal(decide({ ...request, entry: 'com.example.pkg/entry' }).allow, false);
  assert.equal(decide({ ...request, door: 'mcp', entry: null }).allow, false);
});
