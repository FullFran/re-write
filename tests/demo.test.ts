import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { read, tempDir } from './helpers.ts';

test('the documented walkthrough passes on a machine with no git identity and writes its log', () => {
  const home = tempDir();
  const log = join(home, 'walkthrough.log');
  const run = spawnSync(process.execPath, [resolve(import.meta.dirname, '../scripts/demo.ts'), log], {
    encoding: 'utf8',
    env: { PATH: process.env.PATH, HOME: home, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' },
  });
  assert.equal(run.status, 0, run.stdout + run.stderr);
  assert.match(run.stdout, /WALKTHROUGH PASSED/);
  assert.match(read(home, 'walkthrough.log'), /No LLM runs/);
  assert.doesNotMatch(run.stdout, /EXPECTATION FAILED/);
});
