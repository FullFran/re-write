#!/usr/bin/env node
/**
 * Runs the whole walkthrough through the real CLI on a throwaway book, checks
 * each expected outcome, and exits non-zero on the first mismatch.
 *
 *   node scripts/demo.ts [log-file]
 */
import { spawnSync } from 'node:child_process';
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const CLI = join(ROOT, 'src/cli/main.ts');
const FIXTURES = join(ROOT, 'fixtures/demo-book');
const workspace = mkdtempSync(join(tmpdir(), 'rewrite-demo-'));
const book = join(workspace, 'book');
const scene = join(book, 'scenes/escena-01.md');
const logFile = process.argv[2] ? resolve(process.argv[2]) : null;
if (logFile) writeFileSync(logFile, '');

function say(text: string): void {
  console.log(text);
  if (logFile) appendFileSync(logFile, `${text}\n`);
}

function step(title: string): void {
  say(`\n=== ${title} ===`);
}

function rewrite(...args: string[]): string {
  say(`$ rewrite ${args.join(' ').replaceAll(workspace, '<tmp>').replaceAll(ROOT, '.')}`);
  const run = spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8' });
  if (run.status !== 0) throw new Error(`command failed: ${run.stderr}`);
  say(run.stdout.trimEnd().replaceAll(workspace, '<tmp>'));
  return run.stdout;
}

function data(...args: string[]): any {
  const run = spawnSync(process.execPath, [CLI, ...args, '--json'], { encoding: 'utf8' });
  if (run.status !== 0) throw new Error(`command failed: ${run.stderr}`);
  return JSON.parse(run.stdout);
}

function git(dir: string, ...args: string[]): string {
  return spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8' }).stdout.trim();
}

function expect(condition: boolean, label: string): void {
  if (!condition) throw new Error(`EXPECTATION FAILED: ${label}`);
  say(`[ok] ${label}`);
}

function claim(fragment: string): any {
  return data('claims', book).claims.find((c: any) => c.anchor.quote.includes(fragment));
}

try {
  say('This walkthrough is deterministic: claims come from hand annotations and checks are rules. No LLM runs.');

  step('1. Create the book and import two synthetic scenes');
  rewrite('init', book, '--title', 'La puerta de Sal');
  rewrite('import', book, join(FIXTURES, 'escena-01.md'), join(FIXTURES, 'escena-02.md'));

  step('2. Register claims with provenance');
  rewrite('extract', book, '--from', join(FIXTURES, 'annotations.json'));
  rewrite('claims', book);
  const claims = data('claims', book).claims;
  expect(claims.length === 5, 'five claims, all starting as proposed');
  expect(claims.every((c: any) => git(book, 'show', `${c.revision}:${c.source_file}`).includes(c.anchor.quote)),
    'every literal quote exists in its file and revision');

  step('3. Fixtures A and C: the reviewer accepts a fact and a rumor');
  rewrite('review-claim', book, claim('once años').claim_id, 'accept', '--by', 'demo-reviewer');
  rewrite('review-claim', book, claim('Dicen que Bruno').claim_id, 'accept', '--by', 'demo-reviewer', '--note', 'It is a rumor in the book.');
  rewrite('canon', book);
  const canon = data('canon', book).canon;
  expect(canon.length === 1 && canon[0].epistemic_kind === 'narrated_fact', 'A: the accepted fact reaches canon');
  expect(canon.every((c: any) => c.epistemic_kind !== 'rumor'), 'C: the accepted rumor does not reach canon');

  step('4. Fixture B: Elena knows where the key is before she finds out');
  rewrite('check', book);
  const [finding] = data('check', book).findings;
  expect(finding.classification === 'possible_contradiction' && finding.citations.length === 2,
    'B: possible contradiction with two verifiable quotes');

  step('5. Reject a proposed change: the text does not move');
  const change = ['--file', 'scenes/escena-01.md', '--find', 'La llave está bajo la losa del altar', '--finding', finding.finding_id];
  const textBefore = readFileSync(scene, 'utf8');
  const rejected = data('propose', book, ...change, '--replace', 'La llave la tiene Clara', '--rationale', 'First attempt: this still reveals too much.').proposal.proposal_id;
  rewrite('show', book, rejected);
  rewrite('review-proposal', book, rejected, 'reject', '--by', 'demo-reviewer', '--note', 'It still reveals too much.');
  expect(readFileSync(scene, 'utf8') === textBefore, 'after rejecting, the text is byte-identical');

  step('6. Repeat a proposal: nothing is duplicated');
  const replacement = ['--replace', 'No sé quién tiene la llave', '--rationale', 'Elena learns about the hiding place only in scene 2.'];
  const accepted = data('propose', book, ...change, ...replacement).proposal.proposal_id;
  rewrite('propose', book, ...change, ...replacement);
  expect(data('status', book).proposals.length === 2, 'the repeated proposal did not create a new record');

  step('7. Accept the change: a new traceable version');
  rewrite('show', book, accepted);
  rewrite('review-proposal', book, accepted, 'accept', '--by', 'demo-reviewer');
  const shown = data('show', book, accepted).proposal;
  expect(git(book, 'show', `${shown.result_commit}:scenes/escena-01.md`).includes('No sé quién tiene la llave'),
    'the new commit holds the accepted text');
  expect(git(book, 'show', `${shown.base_revision}:scenes/escena-01.md`) === textBefore.trim(),
    'the base revision still holds the original');
  expect(claim('bajo la losa').evidence_status === 'orphaned', 'the evidence for the old sentence is now orphaned');
  expect(data('check', book).findings.length === 0, 'the finding is gone with its evidence');

  step('8. Fixture D: an edit invalidates evidence that canon relied on');
  writeFileSync(scene, readFileSync(scene, 'utf8').replace('once años', 'veinte años'));
  rewrite('claims', book);
  expect(claim('once años').evidence_status === 'orphaned', 'D: the edited quote is orphaned, never shown as current');
  expect(data('canon', book).canon.length === 0, 'D: the fact falls out of canon until someone reviews it again');
  writeFileSync(scene, readFileSync(scene, 'utf8').replace('veinte años', 'once años'));
  expect(claim('once años').evidence_status === 'valid', 'undoing the edit makes the same anchor valid again');

  step('9. Close and reopen: a fresh clone restores everything');
  const clone = join(workspace, 'clone');
  spawnSync('git', ['clone', '-q', book, clone]);
  rewrite('status', clone);
  const restored = data('status', clone);
  expect(restored.claims.length === 5, 'claims restored');
  expect(restored.proposals.filter((p: any) => p.status === 'accepted').length === 1
    && restored.proposals.filter((p: any) => p.status === 'rejected').length === 1, 'proposal decisions restored');
  expect(data('canon', clone).canon.length === 1, 'canon restored');

  say('\nWALKTHROUGH PASSED');
} catch (error) {
  say(`\nWALKTHROUGH FAILED: ${(error as Error).message}`);
  process.exitCode = 1;
} finally {
  rmSync(workspace, { recursive: true, force: true });
}
