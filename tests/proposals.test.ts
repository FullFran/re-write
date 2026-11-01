import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { cli, claimByQuote, extractedBook, git, read, tempDir } from './helpers.ts';

const SCENE = 'scenes/escena-01.md';
const FIND = 'La llave está bajo la losa del altar';
const REPLACE = 'No sé quién tiene la llave';

function propose(dir: string, replace = REPLACE) {
  return cli('propose', dir, '--file', SCENE, '--find', FIND, '--replace', replace, '--rationale', 'Elena cannot know this yet');
}

test('a proposal shows a reviewable diff and changes nothing in the text', () => {
  const dir = extractedBook();
  const before = read(dir, SCENE);
  const result = propose(dir);
  assert.equal(result.code, 0);
  assert.equal(result.json.created, true);
  assert.equal(result.json.proposal.status, 'proposed');
  assert.equal(read(dir, SCENE), before);
  const shown = cli('show', dir, result.json.proposal.proposal_id);
  assert.match(shown.json.diff, new RegExp(`^-.*${FIND}`, 'm'));
  assert.match(shown.json.diff, new RegExp(`^\\+.*${REPLACE}`, 'm'));
  assert.doesNotMatch(shown.json.diff, /\/tmp|rewrite-diff/);
});

test('repeating a proposal does not duplicate it', () => {
  const dir = extractedBook();
  const first = propose(dir).json.proposal.proposal_id;
  const head = git(dir, 'rev-parse', 'HEAD');
  const again = propose(dir);
  assert.equal(again.code, 0);
  assert.equal(again.json.created, false);
  assert.equal(again.json.proposal.proposal_id, first);
  assert.equal(cli('status', dir).json.proposals.length, 1);
  assert.equal(git(dir, 'rev-parse', 'HEAD'), head);
});

test('rejecting keeps the text byte for byte and records who decided', () => {
  const dir = extractedBook();
  const before = read(dir, SCENE);
  const base = git(dir, 'rev-parse', 'HEAD');
  const id = propose(dir).json.proposal.proposal_id;
  const result = cli('review-proposal', dir, id, 'reject', '--by', 'Reviewer', '--note', 'prefiero el misterio');
  assert.equal(result.code, 0);
  assert.equal(read(dir, SCENE), before);
  assert.equal(git(dir, 'diff', base, 'HEAD', '--', 'scenes'), '');
  const shown = cli('show', dir, id).json.proposal;
  assert.equal(shown.status, 'rejected');
  assert.equal(shown.history[0].by, 'Reviewer');
  assert.equal(shown.history[0].note, 'prefiero el misterio');
  assert.equal(shown.result_commit, undefined);
});

test('accepting creates a traceable new version and keeps the old one in history', () => {
  const dir = extractedBook();
  const original = read(dir, SCENE);
  const proposal = propose(dir).json.proposal;
  const result = cli('review-proposal', dir, proposal.proposal_id, 'accept', '--by', 'Reviewer');
  assert.equal(result.code, 0);
  assert.ok(read(dir, SCENE).includes(REPLACE));
  assert.ok(!read(dir, SCENE).includes(FIND));
  const shown = cli('show', dir, proposal.proposal_id).json.proposal;
  assert.equal(shown.status, 'accepted');
  assert.ok(git(dir, 'show', `${shown.result_commit}:${SCENE}`).includes(REPLACE));
  assert.equal(git(dir, 'show', `${proposal.base_revision}:${SCENE}`).trim(), original.trim());
  assert.equal(git(dir, 'status', '--porcelain'), '');
});

test('accepting a text change does not touch canon, and the old evidence shows as orphaned', () => {
  const dir = extractedBook();
  const id = propose(dir).json.proposal.proposal_id;
  cli('review-proposal', dir, id, 'accept', '--by', 'Reviewer');
  const claim = claimByQuote(dir, 'bajo la losa');
  assert.equal(claim.editorial_status, 'proposed');
  assert.equal(claim.evidence_status, 'orphaned');
  assert.deepEqual(cli('canon', dir).json.canon, []);
  assert.deepEqual(cli('check', dir).json.findings, []);
  assert.equal(git(dir, 'show', `${claim.revision}:${SCENE}`).includes(FIND), true);
});

test('a proposal is refused when the scene changed after it was made, and nothing is written', () => {
  const dir = extractedBook();
  const first = propose(dir).json.proposal.proposal_id;
  const second = propose(dir, 'Otra versión').json.proposal.proposal_id;
  cli('review-proposal', dir, first, 'accept', '--by', 'Reviewer');
  const after = read(dir, SCENE);
  const result = cli('review-proposal', dir, second, 'accept', '--by', 'Reviewer');
  assert.equal(result.code, 1);
  assert.match(result.stderr, /changed since/);
  assert.equal(read(dir, SCENE), after);
  assert.equal(cli('show', dir, second).json.proposal.status, 'proposed');
  assert.equal(cli('show', dir, second).json.applicable, false);
});

test('proposal transitions: a repeated decision is a no-op, the opposite one is refused', () => {
  const dir = extractedBook();
  const id = propose(dir).json.proposal.proposal_id;
  cli('review-proposal', dir, id, 'reject', '--by', 'Reviewer');
  const head = git(dir, 'rev-parse', 'HEAD');
  assert.equal(cli('review-proposal', dir, id, 'reject', '--by', 'Reviewer').json.changed, false);
  assert.equal(git(dir, 'rev-parse', 'HEAD'), head);
  const opposite = cli('review-proposal', dir, id, 'accept', '--by', 'Reviewer');
  assert.equal(opposite.code, 1);
  assert.match(opposite.stderr, /already rejected/);
  assert.ok(!read(dir, SCENE).includes(REPLACE));
});

test('propose refuses absent or ambiguous text, a no-op change, uncommitted edits and outside paths', () => {
  const dir = extractedBook();
  const run = (file: string, find: string, replace: string) =>
    cli('propose', dir, '--file', file, '--find', find, '--replace', replace, '--rationale', 'r');
  assert.match(run(SCENE, 'nadie escribió esto', 'x').stderr, /not found/);
  assert.match(run(SCENE, 'Elena', 'x').stderr, /appears \d+ times/);
  assert.match(run(SCENE, FIND, FIND).stderr, /changes nothing/);
  assert.match(run('../fuera.md', 'x', 'y').stderr, /inside scenes/);
  writeFileSync(join(dir, SCENE), `${read(dir, SCENE)}\nedición sin guardar\n`);
  assert.match(run(SCENE, FIND, 'x').stderr, /uncommitted/);
  assert.equal(cli('status', dir).json.proposals.length, 0);
});

test('propose refuses an unknown finding, and records a known one', () => {
  const dir = extractedBook();
  const args = ['--file', SCENE, '--find', FIND, '--replace', REPLACE, '--rationale', 'r'];
  assert.match(cli('propose', dir, ...args, '--finding', 'F-none').stderr, /unknown finding/);
  const { finding_id } = cli('check', dir).json.findings[0];
  assert.equal(cli('propose', dir, ...args, '--finding', finding_id).json.proposal.finding_id, finding_id);
});

test('a proposal and its decision are restored by a fresh clone', () => {
  const dir = extractedBook();
  const id = propose(dir).json.proposal.proposal_id;
  cli('review-proposal', dir, id, 'accept', '--by', 'Reviewer');
  const clone = join(tempDir(), 'clone');
  git(tempDir(), 'clone', '-q', dir, clone);
  const shown = cli('show', clone, id).json.proposal;
  assert.equal(shown.status, 'accepted');
  assert.equal(shown.history[0].by, 'Reviewer');
  assert.equal(git(clone, 'rev-parse', 'HEAD'), git(dir, 'rev-parse', 'HEAD'));
  assert.equal(shown.result_commit, git(dir, 'rev-parse', 'HEAD'));
});
