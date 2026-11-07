import assert from 'node:assert/strict';
import { test } from 'node:test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { cli, newBook, git, read, tempDir } from './helpers.ts';
import { HcsFailure, hcsError } from '../src/hcs/errors.ts';
import { renderFailure } from '../src/cli/main.ts';

const base = 'https://github.com/FullFran/re-write/blob/main/docs/problems.md#';

test('CLI renders HCS failures as the original HCS object', () => {
  const error = hcsError('timeout', 'Timed out');
  assert.deepEqual(JSON.parse(renderFailure(new HcsFailure([error]), true).text), error);
  assert.equal(renderFailure(new HcsFailure([error]), true).code, 1);
});

test('CLI extract adds a product problem to each rejected quote', () => {
  const dir = newBook();
  const input = join(tempDir(), 'candidates.json');
  writeFileSync(input, JSON.stringify({ extractor: 'test', candidates: [{ statement: 'test', subject: 'test', source_file: 'scenes/escena-01.md', quote: 'not a literal quote', scope: 'book', epistemic_kind: 'narrated_fact' }] }));
  const before = git(dir, 'rev-parse', 'HEAD');
  const result = cli('extract', dir, '--from', input);
  assert.equal(result.code, 0);
  assert.equal(result.stderr, '');
  assert.equal(result.json.created.length, 0);
  assert.equal(result.json.existing.length, 0);
  const rejected = result.json.rejected[0];
  assert.match(rejected.reason, /quote not found/);
  assert.equal(rejected.problem.type, `${base}quote-not-literal`);
  assert.equal(rejected.problem.detail, rejected.reason);
  assert.equal('hcsError' in rejected.problem, false);
  assert.equal(cli('claims', dir).json.claims.length, 0);
  assert.equal(git(dir, 'rev-parse', 'HEAD'), before);
});

test('CLI JSON refusals preserve exit codes and leave proposals unchanged', () => {
  const dir = newBook();
  const before = read(dir, 'scenes/escena-01.md');
  const head = git(dir, 'rev-parse', 'HEAD');
  const success = cli('status', dir);
  assert.equal(success.code, 0);
  assert.equal(success.stderr, '');
  const refusal = cli('propose', dir, '--file', 'scenes/escena-01.md', '--find', 'not literal', '--replace', 'x', '--rationale', 'r');
  assert.equal(refusal.code, 1);
  assert.equal(refusal.stdout, '');
  const problem = JSON.parse(refusal.stderr);
  assert.ok(problem.type.startsWith(base));
  assert.equal('hcsError' in problem, false);
  assert.match(problem.detail, /not found/);
  const usage = cli('nonsense');
  assert.equal(usage.code, 2);
  assert.equal(usage.stdout, '');
  assert.ok(JSON.parse(usage.stderr).type.startsWith(base));
  assert.equal(read(dir, 'scenes/escena-01.md'), before);
  assert.equal(git(dir, 'rev-parse', 'HEAD'), head);
  assert.equal(cli('status', dir).json.proposals.length, 0);
});
