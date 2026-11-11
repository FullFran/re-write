import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';
import type { Project } from '../src/application/project.ts';
import { cli, FIXTURES, git } from './helpers.ts';
import { proposeRevision, reviewApi, startHarness, type Harness } from './server-helpers.ts';

const SCENE = 'scenes/escena-01.md';
const STRAY = '.rewrite/proposals/P-stray00000.json';
let h: Harness;

beforeEach(async () => {
  h = await startHarness();
  cli('extract', h.bookDir, '--from', join(FIXTURES, 'annotations.json'));
});

afterEach(() => h?.close());

const status = () => git(h.bookDir, 'status', '--porcelain', '--untracked-files=all');
const head = () => git(h.bookDir, 'rev-parse', 'HEAD');
const book = (): Project => h.library.open('sal', 'user_fran');

/** Runs `run` while git cannot take the index lock, so every commit fails. */
function withLockedIndex(run: () => void): void {
  const lock = join(h.bookDir, '.git', 'index.lock');
  writeFileSync(lock, '');
  try {
    run();
  } finally {
    rmSync(lock);
  }
}

test('a decision commits only its own records, never other files under .rewrite/', async () => {
  const session = await h.session();
  const id = proposeRevision(h.bookDir, SCENE, 'Fuera empezaba a llover', 'Fuera seguía lloviendo');
  writeFileSync(join(h.bookDir, STRAY), '{}\n');
  const res = await reviewApi(h, `/books/sal/proposals/${id}`, session, { decision: 'reject' });
  assert.equal(res.status, 200);
  assert.equal(git(h.bookDir, 'show', '--name-only', '--format=', 'HEAD'), `.rewrite/proposals/${id}.json`);
  assert.equal(status(), `?? ${STRAY}`);
});

test('a failed accept leaves other files under .rewrite/ unstaged, as they were', async () => {
  const session = await h.session();
  const id = proposeRevision(h.bookDir, SCENE, 'Fuera empezaba a llover', 'Fuera seguía lloviendo');
  writeFileSync(join(h.bookDir, STRAY), '{}\n');
  // Signing with a program that fails makes `git commit` fail after `git add` staged the paths.
  git(h.bookDir, 'config', 'commit.gpgsign', 'true');
  git(h.bookDir, 'config', 'gpg.program', 'false');
  const res = await reviewApi(h, `/books/sal/proposals/${id}`, session, { decision: 'accept' });
  git(h.bookDir, 'config', '--unset', 'commit.gpgsign');
  assert.equal(res.status, 409);
  assert.equal(status(), `?? ${STRAY}`);
});

test('a failed proposal leaves nothing on disk, and a retry creates and commits it', () => {
  const headBefore = head();
  const input = { file: SCENE, find: 'Fuera empezaba a llover', replace: 'Fuera seguía lloviendo', rationale: 'r' };
  withLockedIndex(() => assert.throws(() => book().proposeRevision(input)));
  assert.equal(status(), '');
  assert.equal(head(), headBefore);

  const retry = book().proposeRevision(input);
  assert.equal(retry.created, true);
  assert.equal(git(h.bookDir, 'log', '-1', '--format=%s'), `rewrite: propose ${retry.proposal.proposal_id}`);
  assert.equal(status(), '');
});

test('failed claim extraction, finding proposals and scene imports leave nothing on disk, and retries commit them', () => {
  const candidate = {
    statement: 'El puente es de Sal', subject: 'puente', source_file: SCENE, quote: 'el puente de Sal',
    scope: 'scene', epistemic_kind: 'narrated_fact' as const,
  };
  const finding = { question: 'motivation' as const, kind: 'interpretation' as const, statement: 'Elena protege a Bruno', evidence: [{ file: SCENE, quote: 'No fue Bruno' }] };
  const outside = mkdtempSync(join(tmpdir(), 'rewrite-scope-'));
  const scene = join(outside, 'escena-09.md');
  writeFileSync(scene, 'Texto sintético.\n');
  try {
    withLockedIndex(() => {
      assert.throws(() => book().extractClaims({ extractor: 'test', candidates: [candidate] }));
      assert.throws(() => book().proposeFindings([finding], 'agent'));
      assert.throws(() => book().importScenes([scene]));
    });
    assert.equal(status(), '');
    assert.equal(existsSync(join(h.bookDir, 'scenes', 'escena-09.md')), false);

    assert.equal(book().extractClaims({ extractor: 'test', candidates: [candidate] }).created.length, 1);
    assert.equal(book().proposeFindings([finding], 'agent').created.length, 1);
    assert.deepEqual(book().importScenes([scene]).imported, ['scenes/escena-09.md']);
    assert.equal(status(), '');
  } finally {
    rmSync(outside, { recursive: true, force: true });
  }
});
