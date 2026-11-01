import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { cli, claimByQuote, extractedBook, FIXTURES, git, newBook, read, tempDir } from './helpers.ts';

function bookWith(change: (candidates: any[]) => void): string {
  const dir = newBook();
  const annotations = JSON.parse(read(FIXTURES, 'annotations.json'));
  change(annotations.candidates);
  const path = join(tempDir(), 'annotations.json');
  writeFileSync(path, JSON.stringify(annotations));
  cli('extract', dir, '--from', path);
  return dir;
}

test('fixture B: a character who knows a fact before learning it yields two verifiable quotes', () => {
  const dir = extractedBook();
  const result = cli('check', dir);
  assert.equal(result.code, 0);
  assert.equal(result.json.findings.length, 1);
  const finding = result.json.findings[0];
  assert.equal(finding.classification, 'possible_contradiction');
  assert.equal(finding.holder, 'Elena');
  assert.equal(finding.method, 'rule:knowledge-order');
  assert.equal(finding.citations.length, 2);
  for (const citation of finding.citations) {
    assert.ok(git(dir, 'show', `${citation.revision}:${citation.source_file}`).includes(citation.quote));
  }
  assert.ok(finding.alternatives.some((a: string) => a.startsWith('deliberate_mystery')));
  assert.ok(finding.alternatives.some((a: string) => a.startsWith('insufficient_evidence')));
});

test('fixture A: claims with no knowledge conflict produce no finding', () => {
  const dir = bookWith((candidates) => {
    candidates.splice(0, candidates.length, candidates[0], candidates[1]);
  });
  assert.deepEqual(cli('check', dir).json.findings, []);
});

test('story time decides, not reading order: a flashback read later is not a leak', () => {
  const dir = bookWith((candidates) => {
    candidates[4].story_time = 0;
  });
  assert.equal(claimByQuote(dir, 'hasta esa noche').reveal_order, 5);
  assert.deepEqual(cli('check', dir).json.findings, []);
});

test('an earlier rumor about the same fact lowers the finding to insufficient evidence', () => {
  const dir = bookWith((candidates) => {
    candidates[1].story_time = 0;
    candidates[1].knowledge = { holder: 'Elena', fact: 'key-under-altar', mode: 'hears' };
  });
  const [finding] = cli('check', dir).json.findings;
  assert.equal(finding.classification, 'insufficient_evidence');
  assert.equal(finding.citations.length, 3);
});

test('without story time the order is unknown, so nothing is asserted as a contradiction', () => {
  const dir = bookWith((candidates) => {
    delete candidates[2].story_time;
  });
  const [finding] = cli('check', dir).json.findings;
  assert.equal(finding.classification, 'insufficient_evidence');
  assert.match(finding.explanation, /story time/);
});

test('a fact with no recorded way of learning it is insufficient evidence, not a contradiction', () => {
  const dir = bookWith((candidates) => {
    candidates.splice(4, 1);
  });
  const [finding] = cli('check', dir).json.findings;
  assert.equal(finding.classification, 'insufficient_evidence');
  assert.equal(finding.citations.length, 1);
});

test('stale evidence lowers the finding, and an orphaned quote leaves it out', () => {
  const dir = extractedBook();
  const file = join(dir, 'scenes/escena-01.md');
  const original = read(dir, 'scenes/escena-01.md');
  writeFileSync(file, original.replace('—No fue Bruno —dijo Elena—. La llave', 'Elena mintió: La llave'));
  const [finding] = cli('check', dir).json.findings;
  assert.equal(finding.classification, 'insufficient_evidence');
  assert.match(finding.explanation, /stale/);
  writeFileSync(file, original.replace('La llave está bajo la losa del altar', 'No sé dónde está'));
  assert.deepEqual(cli('check', dir).json.findings, []);
});

test('a rejected claim no longer supports a finding', () => {
  const dir = extractedBook();
  const claim = claimByQuote(dir, 'bajo la losa');
  cli('review-claim', dir, claim.claim_id, 'reject', '--by', 'Reviewer');
  assert.deepEqual(cli('check', dir).json.findings, []);
});

test('checking twice gives the same finding id and changes nothing', () => {
  const dir = extractedBook();
  const head = git(dir, 'rev-parse', 'HEAD');
  const first = cli('check', dir).json.findings[0].finding_id;
  assert.equal(cli('check', dir).json.findings[0].finding_id, first);
  assert.equal(git(dir, 'rev-parse', 'HEAD'), head);
});

test('a human verdict persists and changes neither the text nor the claims', () => {
  const dir = extractedBook();
  const before = read(dir, 'scenes/escena-01.md');
  const { finding_id } = cli('check', dir).json.findings[0];
  const result = cli('review-finding', dir, finding_id, 'deliberate_mystery', '--by', 'Reviewer', '--note', 'Elena lied');
  assert.equal(result.code, 0);
  const [after] = cli('check', dir).json.findings;
  assert.equal(after.verdict.verdict, 'deliberate_mystery');
  assert.equal(after.verdict.by, 'Reviewer');
  assert.equal(read(dir, 'scenes/escena-01.md'), before);
  assert.equal(claimByQuote(dir, 'bajo la losa').editorial_status, 'proposed');
});

test('review-finding refuses an unknown finding and an unknown verdict', () => {
  const dir = extractedBook();
  const unknown = cli('review-finding', dir, 'F-none', 'false_positive');
  assert.equal(unknown.code, 1);
  assert.match(unknown.stderr, /unknown finding/);
  const { finding_id } = cli('check', dir).json.findings[0];
  assert.equal(cli('review-finding', dir, finding_id, 'whatever').code, 2);
});
