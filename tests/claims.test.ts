import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { CLI, cli, claimByQuote, extractedBook, FIXTURES, git, newBook, read, tempDir } from './helpers.ts';

test('init and import version the synthetic scenes', () => {
  const dir = newBook();
  const status = cli('status', dir);
  assert.equal(status.code, 0);
  assert.deepEqual(status.json.scenes, ['scenes/escena-01.md', 'scenes/escena-02.md']);
  assert.equal(git(dir, 'status', '--porcelain'), '');
  assert.equal(read(dir, 'scenes/escena-02.md'), read(FIXTURES, 'escena-02.md'));
});

test('import refuses to overwrite an existing scene with different text', () => {
  const dir = newBook();
  const other = join(tempDir(), 'escena-01.md');
  writeFileSync(other, 'otro texto\n');
  const result = cli('import', dir, other);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /already exists with different text/);
  assert.equal(read(dir, 'scenes/escena-01.md'), read(FIXTURES, 'escena-01.md'));
});

test('import is all-or-nothing: a mixed batch writes nothing on conflict or invalid name', () => {
  const dir = newBook();
  const newScene = join(tempDir(), 'escena-03.md');
  writeFileSync(newScene, '# Escena 3\nNuevo contenido\n');
  const conflictScene = join(tempDir(), 'escena-01.md');
  writeFileSync(conflictScene, 'texto en conflicto\n');

  // Conflict case
  const result = cli('import', dir, newScene, conflictScene);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /already exists with different text/);

  // Neither the conflicting file was overwritten, nor was the new scene written to disk
  assert.equal(existsSync(join(dir, 'scenes/escena-03.md')), false);
  assert.equal(read(dir, 'scenes/escena-01.md'), read(FIXTURES, 'escena-01.md'));
  assert.equal(git(dir, 'status', '--porcelain'), '');

  // Invalid name case in mixed batch
  const invalidScene = join(tempDir(), '.md');
  writeFileSync(invalidScene, '# Invalid name\n');
  const result2 = cli('import', dir, newScene, invalidScene);
  assert.equal(result2.code, 1);
  assert.equal(existsSync(join(dir, 'scenes/escena-03.md')), false);
  assert.equal(git(dir, 'status', '--porcelain'), '');
});

test('extraction records full provenance and starts every claim as proposed', () => {
  const dir = newBook();
  const head = git(dir, 'rev-parse', 'HEAD');
  const result = cli('extract', dir, '--from', join(FIXTURES, 'annotations.json'));
  assert.equal(result.code, 0);
  assert.equal(result.json.created.length, 5);
  for (const claim of cli('claims', dir).json.claims) {
    assert.equal(claim.revision, head);
    assert.equal(claim.editorial_status, 'proposed');
    assert.equal(claim.evidence_status, 'valid');
    assert.equal(claim.extractor, 'fixture-annotations');
    assert.ok(claim.source_file && claim.scope && claim.epistemic_kind && claim.statement);
    // Every literal quote exists in the referenced file and revision.
    assert.ok(git(dir, 'show', `${claim.revision}:${claim.source_file}`).includes(claim.anchor.quote));
  }
});

test('extraction rejects a candidate whose quote is not literally in the scene', () => {
  const dir = newBook();
  const annotations = join(tempDir(), 'fake.json');
  writeFileSync(annotations, JSON.stringify({
    extractor: 'fixture-annotations',
    candidates: [{
      statement: 'Invented.', subject: 'Elena', source_file: 'scenes/escena-01.md',
      quote: 'una frase que nadie escribió', scope: 'book', epistemic_kind: 'narrated_fact',
    }],
  }));
  const result = cli('extract', dir, '--from', annotations);
  assert.equal(result.code, 0);
  assert.equal(result.json.created.length, 0);
  assert.match(result.json.rejected[0].reason, /not found/);
  assert.equal(cli('claims', dir).json.claims.length, 0);
});

test('extraction refuses a source path outside scenes', () => {
  const dir = newBook();
  const annotations = join(tempDir(), 'escape.json');
  writeFileSync(annotations, JSON.stringify({
    extractor: 'fixture-annotations',
    candidates: [{
      statement: 'x', subject: 'x', source_file: '../secret.md',
      quote: 'x', scope: 'book', epistemic_kind: 'narrated_fact',
    }],
  }));
  const result = cli('extract', dir, '--from', annotations);
  assert.match(result.json.rejected[0].reason, /inside scenes/);
});

test('repeating extraction does not duplicate claims', () => {
  const dir = extractedBook();
  const head = git(dir, 'rev-parse', 'HEAD');
  const again = cli('extract', dir, '--from', join(FIXTURES, 'annotations.json'));
  assert.equal(again.json.created.length, 0);
  assert.equal(again.json.existing.length, 5);
  assert.equal(cli('claims', dir).json.claims.length, 5);
  assert.equal(git(dir, 'rev-parse', 'HEAD'), head);
});

test('fixture A: a consistent narrated fact can be accepted and reaches canon', () => {
  const dir = extractedBook();
  const claim = claimByQuote(dir, 'once años');
  assert.deepEqual(cli('canon', dir).json.canon, []);
  const result = cli('review-claim', dir, claim.claim_id, 'accept', '--by', 'Reviewer', '--note', 'ok');
  assert.equal(result.code, 0);
  const updated = claimByQuote(dir, 'once años');
  assert.equal(updated.editorial_status, 'accepted');
  assert.equal(updated.history[0].by, 'Reviewer');
  assert.deepEqual(cli('canon', dir).json.canon.map((c: any) => c.claim_id), [claim.claim_id]);
});

test('fixture C: an accepted rumor stays a rumor and never reaches canon', () => {
  const dir = extractedBook();
  const rumor = claimByQuote(dir, 'Dicen que Bruno');
  assert.equal(rumor.epistemic_kind, 'rumor');
  assert.match(rumor.uncertainty, /did not see/);
  assert.equal(cli('review-claim', dir, rumor.claim_id, 'accept', '--by', 'Reviewer').code, 0);
  assert.equal(claimByQuote(dir, 'Dicen que Bruno').editorial_status, 'accepted');
  assert.deepEqual(cli('canon', dir).json.canon, []);
});

test('fixture D: an edit that removes the quote orphans its evidence and drops it from canon', () => {
  const dir = extractedBook();
  const claim = claimByQuote(dir, 'once años');
  cli('review-claim', dir, claim.claim_id, 'accept', '--by', 'Reviewer');
  const file = join(dir, 'scenes/escena-01.md');
  writeFileSync(file, read(dir, 'scenes/escena-01.md').replace('once años', 'veinte años'));
  const updated = claimByQuote(dir, 'once años');
  assert.equal(updated.evidence_status, 'orphaned');
  assert.equal(updated.evidence_reason, 'quote_not_found');
  assert.deepEqual(cli('canon', dir).json.canon, []);
});

test('an edit that changes the words around the quote makes the evidence stale', () => {
  const dir = extractedBook();
  const file = join(dir, 'scenes/escena-01.md');
  writeFileSync(file, read(dir, 'scenes/escena-01.md').replace('—No fue Bruno —dijo Elena—. La llave', 'Elena mintió: La llave'));
  const claim = claimByQuote(dir, 'bajo la losa');
  assert.equal(claim.evidence_status, 'stale');
  assert.equal(claim.evidence_reason, 'context_changed');
});

test('an edit that only moves the passage revalidates the anchor at its new position', () => {
  const dir = extractedBook();
  const before = claimByQuote(dir, 'Clara levantó');
  const file = join(dir, 'scenes/escena-02.md');
  writeFileSync(file, read(dir, 'scenes/escena-02.md').replace('# El altar\n', '# El altar\n\nPárrafo nuevo.\n'));
  const after = claimByQuote(dir, 'Clara levantó');
  assert.equal(after.evidence_status, 'valid');
  assert.equal(after.evidence_reason, 'relocated');
  assert.ok(after.current_start > before.anchor.start);
  assert.equal(after.anchor.start, before.anchor.start);
});

test('a tampered stored quote is orphaned, never shown as current evidence', () => {
  const dir = extractedBook();
  const claim = claimByQuote(dir, 'once años');
  const path = join(dir, '.rewrite/claims', `${claim.claim_id}.json`);
  const stored = JSON.parse(read(dir, `.rewrite/claims/${claim.claim_id}.json`));
  stored.anchor.quote = 'cuando el puente cayó al río';
  writeFileSync(path, JSON.stringify(stored));
  const updated = cli('claims', dir).json.claims.find((c: any) => c.claim_id === claim.claim_id);
  assert.equal(updated.evidence_status, 'orphaned');
  assert.equal(updated.evidence_reason, 'quote_not_in_revision');
});

test('a claim without valid evidence cannot be accepted', () => {
  const dir = extractedBook();
  const claim = claimByQuote(dir, 'once años');
  writeFileSync(join(dir, 'scenes/escena-01.md'), 'texto reescrito\n');
  const result = cli('review-claim', dir, claim.claim_id, 'accept', '--by', 'Reviewer');
  assert.equal(result.code, 1);
  assert.match(result.stderr, /evidence is orphaned/);
  assert.equal(claimByQuote(dir, 'once años').editorial_status, 'proposed');
});

test('editorial transitions: a repeated decision is a no-op, the opposite one is refused', () => {
  const dir = extractedBook();
  const claim = claimByQuote(dir, 'once años');
  cli('review-claim', dir, claim.claim_id, 'reject', '--by', 'Reviewer');
  const head = git(dir, 'rev-parse', 'HEAD');
  const repeat = cli('review-claim', dir, claim.claim_id, 'reject', '--by', 'Reviewer');
  assert.equal(repeat.code, 0);
  assert.equal(repeat.json.changed, false);
  assert.equal(git(dir, 'rev-parse', 'HEAD'), head);
  const opposite = cli('review-claim', dir, claim.claim_id, 'accept', '--by', 'Reviewer');
  assert.equal(opposite.code, 1);
  assert.match(opposite.stderr, /already rejected/);
  assert.equal(claimByQuote(dir, 'once años').history.length, 1);
});

test('state survives closing and reopening: a new process restores claims and decisions', () => {
  const dir = extractedBook();
  const claim = claimByQuote(dir, 'once años');
  cli('review-claim', dir, claim.claim_id, 'accept', '--by', 'Reviewer');
  // Each cli() call is a fresh process, and a clone proves the state is in the repository.
  const clone = join(tempDir(), 'clone');
  git(tempDir(), 'clone', '-q', dir, clone);
  const restored = cli('claims', clone).json.claims;
  assert.equal(restored.length, 5);
  assert.equal(restored.find((c: any) => c.claim_id === claim.claim_id).editorial_status, 'accepted');
  assert.equal(restored.find((c: any) => c.claim_id === claim.claim_id).evidence_status, 'valid');
});

test('extraction only says "no LLM" for the hand annotations', () => {
  const dir = newBook();
  const run = (extractor: string) => {
    const path = join(tempDir(), 'candidates.json');
    writeFileSync(path, JSON.stringify({ extractor, candidates: [] }));
    return spawnSync(process.execPath, [CLI, 'extract', dir, '--from', path], { encoding: 'utf8' }).stdout;
  };
  assert.match(run('fixture-annotations'), /no LLM/);
  assert.doesNotMatch(run('opencode'), /no LLM/);
});
