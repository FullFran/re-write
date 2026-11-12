import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { Project } from '../src/application/project.ts';
import { StaleStateError } from '../src/domain/claim.ts';
import { extractedBook, git, read } from './helpers.ts';

const SCENE = 'scenes/escena-01.md';
const QUOTE = 'Elena llevaba once años custodiando el puente de Sal';
const BY = 'user_fran';

function editScene(dir: string, change: (text: string) => string): void {
  writeFileSync(join(dir, SCENE), change(read(dir, SCENE)));
  git(dir, 'commit', '-qam', 'edit');
}

// The sentence moves to the end of the scene, so its surroundings change and it goes stale.
const moveSentence = (text: string) => text.replace(`${QUOTE}, y conocía cada grieta de sus piedras.\n\n`, '')
  + `\nAquella noche, ${QUOTE}, y conocía cada grieta de sus piedras.\n`;

/** A book whose accepted narrated fact was reopened after its scene changed. */
function reopenedAfter(change: (text: string) => string) {
  const dir = extractedBook();
  const project = Project.open(dir);
  const id = project.claimViews().find((c) => c.anchor.quote === QUOTE)!.claim_id;
  project.reviewClaim(id, 'accept', BY, undefined, 0);
  assert.ok(project.canon().some((c) => c.claim_id === id));
  editScene(dir, change);
  project.reopenClaim(id, BY, 1);
  return { dir, project, id, view: () => project.claimViews().find((c) => c.claim_id === id)! };
}

const commits = (dir: string) => Number(git(dir, 'rev-list', '--count', 'HEAD'));
const stored = (dir: string, id: string) => JSON.parse(read(dir, `.rewrite/claims/${id}.json`));

test('a reopened claim whose quote moved is offered the moved passage, and accepting it appends one entry in one commit', () => {
  const { dir, project, id, view } = reopenedAfter(moveSentence);
  const before = view();
  assert.equal(before.evidence_status, 'stale');
  const text = read(dir, SCENE);
  assert.deepEqual(before.anchor_suggestion, { quote: QUOTE, start: text.indexOf(QUOTE), how: 'moved' });
  assert.deepEqual(before.anchor_proposals, []);
  const original = stored(dir, id).anchor;
  const count = commits(dir);

  const result = project.reanchorClaim(id, { by: BY, expected: 2, quote: QUOTE, note: 'la frase se movió' });
  assert.equal(result.changed, true);
  assert.equal(commits(dir), count + 1);
  assert.equal(git(dir, 'log', '-1', '--format=%s'), `rewrite: reanchor claim ${id}`);
  assert.equal(git(dir, 'show', '--name-only', '--format=', 'HEAD'), `.rewrite/claims/${id}.json`);
  const record = stored(dir, id);
  assert.deepEqual(record.anchor, original, 'the old anchor is never rewritten');
  assert.equal(record.history.length, 3);
  const entry = record.history[2];
  assert.deepEqual([entry.action, entry.from, entry.to, entry.by, entry.note], ['reanchor', 'proposed', 'proposed', BY, 'la frase se movió']);
  assert.equal(entry.anchor.start, text.indexOf(QUOTE));
  assert.equal(entry.revision, git(dir, 'rev-parse', 'HEAD~1'));

  const after = view();
  assert.equal(after.evidence_status, 'valid');
  assert.equal(after.anchor.start, text.indexOf(QUOTE));
  assert.equal(after.anchor_suggestion, undefined);
  assert.equal(after.editorial_status, 'proposed', 'a new anchor is not a decision on the claim');
  assert.ok(!project.canon().some((c) => c.claim_id === id));
  project.reviewClaim(id, 'accept', BY, undefined, 3);
  assert.ok(project.canon().some((c) => c.claim_id === id), 'Canon reads the new anchor');
});

test('an edited quote is offered the closest passage, which can be accepted', () => {
  const edited = 'Elena llevaba doce años custodiando el puente de Sal';
  const { dir, project, id, view } = reopenedAfter((text) => text.replace(QUOTE, edited));
  const before = view();
  assert.equal(before.evidence_status, 'orphaned');
  assert.deepEqual(before.anchor_suggestion, { quote: edited, start: read(dir, SCENE).indexOf(edited), how: 'similar' });
  assert.equal(project.reanchorClaim(id, { by: BY, expected: 2, quote: edited }).changed, true);
  assert.equal(view().evidence_status, 'valid');
  assert.equal(view().anchor.quote, edited);
});

test('a removed quote is offered no passage, and the old quote cannot be accepted as an anchor', () => {
  const { dir, project, id, view } = reopenedAfter((text) => text.replace(`${QUOTE}, y conocía cada grieta de sus piedras.\n\n`, ''));
  const before = view();
  assert.equal(before.evidence_status, 'orphaned');
  assert.equal(before.anchor_suggestion, null);
  const count = commits(dir);
  assert.throws(() => project.reanchorClaim(id, { by: BY, expected: 2, quote: QUOTE }), /quote not found/);
  assert.equal(commits(dir), count);
  assert.equal(stored(dir, id).history.length, 2);
});

test('two tabs: the same new anchor twice is recorded once, a different one after it is refused', () => {
  const { dir, project, id } = reopenedAfter(moveSentence);
  const count = commits(dir);
  assert.equal(project.reanchorClaim(id, { by: BY, expected: 2, quote: QUOTE }).changed, true);
  assert.equal(project.reanchorClaim(id, { by: BY, expected: 2, quote: QUOTE }).changed, false);
  assert.throws(() => project.reanchorClaim(id, { by: BY, expected: 2, quote: 'Elena llevaba once años' }), StaleStateError);
  assert.equal(commits(dir), count + 1);
  assert.equal(stored(dir, id).history.length, 3);
});

test('only undecided claims with evidence that is not valid can be re-anchored', () => {
  const dir = extractedBook();
  const project = Project.open(dir);
  const id = project.claimViews().find((c) => c.anchor.quote === QUOTE)!.claim_id;
  assert.throws(() => project.reanchorClaim(id, { by: BY, expected: 0, quote: QUOTE }), /evidence is valid/);
  project.reviewClaim(id, 'accept', BY, undefined, 0);
  editScene(dir, moveSentence);
  const decided = project.claimViews().find((c) => c.claim_id === id)!;
  assert.equal(decided.evidence_status, 'stale');
  assert.equal(decided.anchor_suggestion, undefined, 'a decided claim is reopened first');
  assert.throws(() => project.reanchorClaim(id, { by: BY, expected: 1, quote: QUOTE }), /reopen it first/);
  assert.throws(() => project.reanchorClaim('C-missing', { by: BY, expected: 0, quote: QUOTE }), /unknown claim/);
});

test('a claim that was never re-anchored reads as before', () => {
  const dir = extractedBook();
  const project = Project.open(dir);
  const views = project.claimViews();
  for (const view of views) {
    const record = stored(dir, view.claim_id);
    assert.deepEqual(view.anchor, record.anchor);
    assert.equal(view.revision, record.revision);
    assert.ok(!('anchor_suggestion' in view) && !('anchor_proposals' in view));
  }
});

test('a finding keeps its evidence and appends the new anchor of one quote', () => {
  const dir = extractedBook();
  const project = Project.open(dir);
  const quote = 'El guardia escupió sobre las losas';
  const { created: [id] } = project.proposeFindings([{
    question: 'motivation', kind: 'fact', statement: 'El guardia desprecia el puente.',
    evidence: [{ file: SCENE, quote }, { file: SCENE, quote: 'Fuera empezaba a llover' }],
  }], BY);
  editScene(dir, (text) => text.replace(`${quote} antes de hablar en voz baja.\n\n`, '') + `\nAl final, ${quote} con asco.\n`);
  const view = () => project.findingViews().find((f) => f.finding_id === id)!;
  const before = view();
  assert.equal(before.evidence[0].status, 'stale');
  assert.equal(before.evidence[0].anchor_suggestion!.quote, quote);
  assert.equal(before.evidence[1].anchor_suggestion, undefined, 'valid evidence has no offer');
  const original = JSON.parse(read(dir, `.rewrite/findings/${id}.json`)).evidence;
  const count = commits(dir);

  assert.throws(() => project.reanchorFinding(id, { by: BY, expected: 0, evidence: 1, quote: 'Fuera empezaba a llover' }), /evidence is valid/);
  assert.throws(() => project.reanchorFinding(id, { by: BY, expected: 0, evidence: 2, quote }), /no evidence 2/);
  assert.equal(project.reanchorFinding(id, { by: BY, expected: 0, evidence: 0, quote }).changed, true);
  assert.equal(project.reanchorFinding(id, { by: BY, expected: 0, evidence: 0, quote }).changed, false);
  assert.equal(commits(dir), count + 1);
  assert.equal(git(dir, 'log', '-1', '--format=%s'), `rewrite: reanchor finding ${id}`);
  const record = JSON.parse(read(dir, `.rewrite/findings/${id}.json`));
  assert.deepEqual(record.evidence, original);
  assert.deepEqual([record.reanchors.length, record.reanchors[0].evidence, record.reanchors[0].by], [1, 0, BY]);
  assert.equal(view().evidence_status, 'valid');

  project.reviewFinding(id, 'useful', BY);
  editScene(dir, (text) => text.replace('Fuera empezaba a llover', 'Fuera llovía'));
  assert.equal(view().evidence[1].anchor_suggestion, undefined, 'a rated finding is reopened first');
  assert.throws(() => project.reanchorFinding(id, { by: BY, expected: 1, evidence: 1, quote: 'Fuera llovía' }), /reopen it first/);
});

test('an agent proposes an anchor; a person accepts it, which closes the proposal', () => {
  const { dir, project, id, view } = reopenedAfter(moveSentence);
  const count = commits(dir);
  const first = project.proposeAnchor({ target: 'claim', item_id: id, quote: QUOTE, rationale: 'se movió', proposed_by: 'user_agent' });
  assert.equal(first.created, true);
  assert.equal(commits(dir), count + 1);
  assert.equal(git(dir, 'show', '--name-only', '--format=', 'HEAD'), `.rewrite/anchor-proposals/${first.proposal.anchor_proposal_id}.json`);
  assert.equal(project.proposeAnchor({ target: 'claim', item_id: id, quote: QUOTE, proposed_by: 'user_agent' }).created, false);
  assert.equal(stored(dir, id).history.length, 2, 'proposing never changes the claim');
  assert.deepEqual(view().anchor_proposals!.map((p) => [p.anchor_proposal_id, p.quote, p.base]), [[first.proposal.anchor_proposal_id, QUOTE, 2]]);
  assert.throws(() => project.proposeAnchor({ target: 'claim', item_id: id, quote: 'no está en la escena', proposed_by: 'user_agent' }), /quote not found/);

  project.reanchorClaim(id, { by: BY, expected: 2, quote: QUOTE, proposal: first.proposal.anchor_proposal_id });
  assert.equal(stored(dir, id).history[2].proposal, first.proposal.anchor_proposal_id);
  assert.equal(view().anchor_proposals, undefined);
  assert.throws(() => project.proposeAnchor({ target: 'claim', item_id: id, quote: QUOTE, proposed_by: 'user_agent' }), /evidence is valid/);
});
