import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';
import { cli, FIXTURES, git, read } from './helpers.ts';
import { reviewApi, startHarness, type Harness } from './server-helpers.ts';

const SCENE = 'scenes/escena-01.md';
const QUOTE = 'Elena llevaba once años custodiando el puente de Sal';
let h: Harness;

beforeEach(async () => {
  h = await startHarness();
  cli('extract', h.bookDir, '--from', join(FIXTURES, 'annotations.json'));
});

afterEach(() => h?.close());

const queue = async (session: string) => (await reviewApi(h, '/books/sal', session)).json();
const commits = () => Number(git(h.bookDir, 'rev-list', '--count', 'HEAD'));

function moveSentence(): void {
  const text = read(h.bookDir, SCENE).replace(`${QUOTE}, y conocía`, `Nadie sabía nada.\n\nAquella noche, ${QUOTE}, y conocía`);
  writeFileSync(join(h.bookDir, SCENE), text);
  git(h.bookDir, 'commit', '-qam', 'edit');
}

/** The accepted narrated fact, reopened after its sentence moved. */
async function reopenedClaim(session: string) {
  const claim = (await queue(session)).claims.find((c: any) => c.anchor.quote === QUOTE);
  await reviewApi(h, `/books/sal/claims/${claim.claim_id}`, session, { decision: 'accept', expected: 0 });
  moveSentence();
  assert.equal((await reviewApi(h, `/books/sal/claims/${claim.claim_id}/reopen`, session, { expected: 1 })).status, 200);
  return claim.claim_id as string;
}

test('the review queue offers the suggested passage, and accepting it re-anchors the claim in one commit', async () => {
  const session = await h.session();
  const id = await reopenedClaim(session);
  const shown = (await queue(session)).claims.find((c: any) => c.claim_id === id);
  assert.equal(shown.evidence_status, 'stale');
  assert.equal(shown.anchor_suggestion.quote, QUOTE);
  const count = commits();

  const res = await reviewApi(h, `/books/sal/claims/${id}/reanchor`, session, { expected: 2, quote: QUOTE, note: 'se movió' });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.changed, true);
  assert.equal(body.claim.evidence_status, 'valid');
  assert.equal(commits(), count + 1);
  assert.equal(git(h.bookDir, 'log', '-1', '--format=%s'), `rewrite: reanchor claim ${id}`);
  const entry = body.claim.history[2];
  assert.deepEqual([entry.action, entry.by, entry.note], ['reanchor', 'user_fran', 'se movió']);

  assert.equal((await reviewApi(h, `/books/sal/claims/${id}`, session, { decision: 'accept', expected: 3 })).status, 200);
  assert.ok((await queue(session)).canon.some((c: any) => c.claim_id === id));
});

test('two tabs: a repeat is unchanged, another anchor on old state is refused, and expected is required', async () => {
  const session = await h.session();
  const id = await reopenedClaim(session);
  const count = commits();
  const path = `/books/sal/claims/${id}/reanchor`;
  assert.equal((await reviewApi(h, path, session, { expected: 2, quote: QUOTE })).status, 200);
  const repeat = await reviewApi(h, path, session, { expected: 2, quote: QUOTE });
  assert.equal(repeat.status, 200);
  assert.equal((await repeat.json()).changed, false);
  const other = await reviewApi(h, path, session, { expected: 2, quote: 'Elena llevaba once años' });
  assert.equal(other.status, 409);
  assert.match((await other.json()).error, /otra pestaña/);
  assert.equal((await reviewApi(h, path, session, { quote: QUOTE })).status, 400);
  assert.equal((await reviewApi(h, path, session, { expected: 3 })).status, 400);
  assert.equal(commits(), count + 1);
});

test('a finding quote is re-anchored by its position', async () => {
  const session = await h.session();
  const quote = 'El guardia escupió sobre las losas';
  const { created: [id] } = h.library.open('sal', 'user_fran').proposeFindings([{
    question: 'motivation', kind: 'fact', statement: 'El guardia desprecia el puente.', evidence: [{ file: SCENE, quote }],
  }], 'user_agent');
  writeFileSync(join(h.bookDir, SCENE), read(h.bookDir, SCENE).replace(`${quote} antes`, `Llovía.\n\n${quote} antes`));
  git(h.bookDir, 'commit', '-qam', 'edit');
  const finding = (await (await reviewApi(h, '/books/sal/findings', session)).json()).findings.find((f: any) => f.finding_id === id);
  assert.equal(finding.evidence[0].anchor_suggestion.quote, quote);

  assert.equal((await reviewApi(h, `/books/sal/findings/${id}/reanchor`, session, { expected: 0, quote })).status, 400, 'a finding names its evidence');
  const res = await reviewApi(h, `/books/sal/findings/${id}/reanchor`, session, { expected: 0, evidence: 0, quote });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).finding.evidence_status, 'valid');
  assert.equal(git(h.bookDir, 'log', '-1', '--format=%s'), `rewrite: reanchor finding ${id}`);
});

test('reanchor is a review action: an agent token is refused, a stranger and a member of another book get the missing-book 404', async () => {
  const session = await h.session();
  const id = await reopenedClaim(session);
  const agent = await h.access();
  for (const kind of ['claims', 'findings']) {
    assert.equal((await reviewApi(h, `/books/sal/${kind}/${id}/reanchor`, agent, { expected: 2, evidence: 0, quote: QUOTE })).status, 401);
  }
  const stranger = await h.session('user_other');
  const missing = await (await reviewApi(h, `/books/nope/claims/${id}/reanchor`, stranger, { expected: 2, quote: QUOTE })).json();
  const head = git(h.bookDir, 'rev-parse', 'HEAD');
  const refused = await reviewApi(h, `/books/sal/claims/${id}/reanchor`, stranger, { expected: 2, quote: QUOTE });
  assert.equal(refused.status, 404);
  assert.deepEqual(await refused.json(), missing);
  assert.equal(git(h.bookDir, 'rev-parse', 'HEAD'), head);

  // Another book whose claim could be re-anchored: only its member may do it.
  const other = join(h.data, 'books', 'otra');
  cli('init', other, '--title', 'Otra');
  cli('import', other, join(FIXTURES, 'escena-01.md'));
  cli('extract', other, '--from', join(FIXTURES, 'annotations.json'));
  writeFileSync(join(other, SCENE), read(other, SCENE).replace(`${QUOTE}, y conocía`, `Nadie sabía nada.\n\nAquella noche, ${QUOTE}, y conocía`));
  git(other, 'commit', '-qam', 'edit');
  h.library.grant('otra', 'user_ana');
  const owner = await h.session('user_ana');
  const otherClaim = (await (await reviewApi(h, '/books/otra', owner)).json()).claims.find((c: any) => c.anchor.quote === QUOTE);
  assert.equal(otherClaim.evidence_status, 'stale');
  const otherHead = git(other, 'rev-parse', 'HEAD');
  const cross = await reviewApi(h, `/books/otra/claims/${otherClaim.claim_id}/reanchor`, session, { expected: 0, quote: QUOTE });
  assert.equal(cross.status, 404);
  assert.deepEqual(await cross.json(), missing);
  assert.equal(git(other, 'rev-parse', 'HEAD'), otherHead);
});
