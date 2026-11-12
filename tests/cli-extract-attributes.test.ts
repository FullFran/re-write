import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { CLI, FIXTURES, cli, extractedBook, tempDir } from './helpers.ts';

// The demo annotations with an age attribute on the first candidate ("once años").
function annotationsWithAge(years: number): string {
  const doc = JSON.parse(readFileSync(join(FIXTURES, 'annotations.json'), 'utf8'));
  doc.candidates[0].attribute = { name: 'años_en', value: years, unit: 'años', about: 'puente de Sal' };
  const file = join(tempDir(), 'annotations.json');
  writeFileSync(file, JSON.stringify(doc));
  return file;
}

test('rewrite extract says in its text output how many stored claims gained an attribute', () => {
  const dir = extractedBook();
  const run = spawnSync(process.execPath, [CLI, 'extract', dir, '--from', annotationsWithAge(11)], { encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /created: 0; existing: \d+; attributed: 1; rejected: 0/);
});

test('rewrite extract rejects a different attribute for a stored claim and keeps the stored one', () => {
  const dir = extractedBook();
  assert.equal(cli('extract', dir, '--from', annotationsWithAge(11)).code, 0);
  const second = cli('extract', dir, '--from', annotationsWithAge(9));
  // A batch reports each refused candidate and goes on, like any other rejected candidate.
  assert.equal(second.code, 0);
  assert.deepEqual(second.json.attributed, []);
  assert.equal(second.json.rejected.length, 1);
  assert.match(second.json.rejected[0].reason, /^attribute_conflict:/);
  const stored = cli('claims', dir).json.claims.find((c: any) => c.attribute);
  assert.equal(stored.attribute.value, 11);
});
