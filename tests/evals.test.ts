import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { z } from 'zod';
import {
  compareRuns, formatTable, inMemoryBuild, RESULTS_SCHEMA, resultRows, runJourneys,
  type Build, type JourneyResult, type RunResults,
} from '../evals/runner.ts';
import { tempDir } from './helpers.ts';

const SCRIPT = resolve(import.meta.dirname, '..', 'scripts', 'eval.ts');
const SCENES = ['fixtures/demo-book/escena-01.md', 'fixtures/demo-book/escena-02.md'];

function evalCli(...args: string[]) {
  const run = spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' });
  return { code: run.status, stdout: run.stdout, stderr: run.stderr };
}

function journeyDir(journeys: Record<string, unknown>): string {
  const dir = tempDir();
  for (const [name, journey] of Object.entries(journeys)) {
    writeFileSync(join(dir, `${name}.json`), typeof journey === 'string' ? journey : JSON.stringify(journey));
  }
  return dir;
}

function journey(id: string, steps: unknown[], scenes = SCENES) {
  return { id, title: id, guarantee: 'none', book: { id: 'sal', title: 'La puerta de Sal', scenes }, steps };
}

function failing(results: RunResults): string[] {
  return results.journeys.filter((item) => item.status === 'FAIL').map((item) => item.id);
}

function run(id: string, status: 'PASS' | 'FAIL', checks: Record<string, 'PASS' | 'FAIL'>): JourneyResult {
  return {
    id, title: id, guarantee: '', status,
    checks: Object.entries(checks).map(([check, state]) => ({ check, status: state, note: state === 'FAIL' ? 'expected true' : '', evidence: '' })),
  };
}

function results(...journeys: JourneyResult[]): RunResults {
  return {
    schema: RESULTS_SCHEMA, version: '0.1.0', commit: 'abc', dirty: false, build: 'in-memory',
    summary: { journeys: { pass: 0, fail: 0 }, checks: { pass: 0, fail: 0 } }, journeys,
  };
}

test('the shipped journeys cover the first set and all pass against this build, identically on every run', async () => {
  const first = await runJourneys();
  assert.deepEqual(first.journeys.map((item) => item.id), [
    'agent-cannot-approve', 'chatgpt-chapter-analysis', 'chatgpt-error-recovery', 'chatgpt-graph-suggestions', 'chatgpt-tool-metadata',
    'continuity-ages-places', 'fabricated-quote', 'literal-quote-claim', 'notes-and-graph', 'onboarding', 'retried-proposal', 'rumor-not-canon', 'showcase-tour',
    'stale-evidence',
  ]);
  assert.deepEqual(resultRows(first).filter((row) => row.status !== 'PASS'), []);
  assert.equal(first.schema, RESULTS_SCHEMA);
  assert.equal(first.version, JSON.parse(readFileSync(resolve(import.meta.dirname, '..', 'package.json'), 'utf8')).version);
  assert.match(first.commit, /^([0-9a-f]{40}|unknown)$/);
  assert.equal(first.build, 'in-memory');
  assert.deepEqual(first.summary.journeys, { pass: 14, fail: 0 });
  assert.equal(first.summary.checks.pass, resultRows(first).length);
  for (const item of first.journeys) {
    assert.ok(item.guarantee, item.id);
    for (const check of item.checks) assert.ok(check.evidence, `${item.id}: ${check.check} records what was observed`);
  }
  // No clock, random id or temporary path may leak into the artifact, or two runs could not be compared.
  assert.deepEqual(await runJourneys(), first);
});

test('runner self-test: a build that allows approval over MCP fails the approval journey', async () => {
  const approving: Build = {
    ...inMemoryBuild,
    name: 'approval-over-mcp',
    server(library, subject) {
      const server = inMemoryBuild.server(library, subject);
      server.registerTool('accept_claim', {
        inputSchema: { book: z.string(), claim_id: z.string(), decision: z.string().optional() },
      }, (args) => {
        const outcome = library.open(args.book, subject).reviewClaim(args.claim_id, 'accept', subject);
        return { content: [{ type: 'text' as const, text: JSON.stringify(outcome) }] };
      });
      return server;
    },
  };
  const broken = await runJourneys({ build: approving });
  // The onboarding journey also notices a tool the public guide does not advertise, and the metadata
  // journey an untitled write tool.
  assert.deepEqual(failing(broken), ['agent-cannot-approve', 'chatgpt-tool-metadata', 'onboarding']);
  assert.equal(broken.build, 'approval-over-mcp');
  const approval = broken.journeys.find((item) => item.id === 'agent-cannot-approve')!;
  assert.deepEqual(approval.checks.filter((check) => check.status === 'FAIL').map((check) => check.check), [
    'no tool accepts, rejects or reviews', 'accept_claim is refused', 'the claim is still proposed', 'nothing reached canon',
  ]);
  assert.match(approval.checks[1].note, /accept_claim/);
  const metadata = broken.journeys.find((item) => item.id === 'chatgpt-tool-metadata')!;
  assert.deepEqual(metadata.checks.filter((check) => check.status === 'FAIL').map((check) => check.check), [
    'every tool has a title', 'every description starts with Use this', 'only the five proposal tools are write tools',
  ]);
  assert.deepEqual(broken.summary.journeys, { pass: 11, fail: 3 });
});

test('runner self-test: a tool list that grows past its budget fails the metadata journey', async () => {
  const bloated: Build = {
    ...inMemoryBuild,
    name: 'bloated-tool-list',
    server(library, subject) {
      const server = inMemoryBuild.server(library, subject);
      server.registerTool('list_more', {
        title: 'Ver más', description: `Use this ${'never '.repeat(1000)}`, annotations: { readOnlyHint: true },
      }, () => ({ content: [{ type: 'text' as const, text: '{}' }] }));
      return server;
    },
  };
  const outcome = await runJourneys({ build: bloated });
  assert.deepEqual(failing(outcome), ['chatgpt-tool-metadata', 'onboarding']);
  const metadata = outcome.journeys.find((item) => item.id === 'chatgpt-tool-metadata')!;
  assert.deepEqual(metadata.checks.filter((check) => check.status === 'FAIL').map((check) => `${check.check}: ${check.note}`), [
    'the tool list stays under 30 KB: expected at most 30000',
  ]);
});

test('runner self-test: onboarding text that names a tool the harness does not offer fails the onboarding journey', async () => {
  const misleading: Build = {
    ...inMemoryBuild,
    name: 'misleading-onboarding',
    llms: (resource) => inMemoryBuild.llms(resource).replace('`graph_suggest_links`.', '`graph_suggest_links`, `accept_claim`.'),
  };
  assert.deepEqual(failing(await runJourneys({ build: misleading })), ['onboarding']);
});

test('runner self-test: a build that writes a proposed note without a person fails the notes journey', async () => {
  const eager: Build = {
    ...inMemoryBuild,
    name: 'note-without-review',
    server(library, subject) {
      const open = library.open.bind(library);
      const shortcut = Object.create(library, {
        open: {
          value: (book: string, who: string) => {
            const project = open(book, who);
            const propose = project.proposeNote.bind(project);
            project.proposeNote = (input) => {
              const result = propose(input);
              project.reviewProposal(result.proposal.proposal_id, 'accept', who);
              return result;
            };
            return project;
          },
        },
      });
      return inMemoryBuild.server(shortcut, subject);
    },
  };
  const outcome = await runJourneys({ build: eager });
  assert.deepEqual(failing(outcome), ['notes-and-graph']);
  const notes = outcome.journeys.find((item) => item.id === 'notes-and-graph')!;
  assert.ok(notes.checks.some((check) => check.status === 'FAIL' && check.check === 'no note exists before a person accepts'));
});

test('runner self-test: a person review of a proposal must say accept or reject', async () => {
  const dir = journeyDir({
    'no-decision': journey('no-decision', [
      { id: 'books', do: 'call', tool: 'list_books', checks: [{ name: 'lists a book', path: 'books.is_error', equals: false }] },
      { id: 'review', do: 'person_reviews_proposal', proposal_id: 'P-0000000000', checks: [{ name: 'reviewed', path: 'review.status', equals: 'accepted' }] },
    ]),
  });
  const outcome = await runJourneys({ dir });
  assert.deepEqual(failing(outcome), ['no-decision']);
  const checks = outcome.journeys[0].checks.map((check) => `${check.status} ${check.check}: ${check.note}`);
  assert.ok(checks.some((line) => /^FAIL step review runs: decision must be "accept" or "reject"/.test(line)), checks.join('\n'));
});

test('the runner fails closed: a journey that cannot load, cannot run or checks nothing real is FAIL, never SKIP', async () => {
  const call = { id: 'books', do: 'call', tool: 'list_books' };
  const dir = journeyDir({
    'broken-json': '{',
    'missing-fixture': journey('missing-fixture', [{ ...call, checks: [{ name: 'lists a book', path: 'books.is_error', equals: false }] }], ['fixtures/demo-book/absent.md']),
    'missing-path': journey('missing-path', [{ ...call, checks: [{ name: 'reads a field', path: 'books.data.nothing.here', equals: 1 }] }]),
    'no-checks': journey('no-checks', [call]),
    'unknown-action': journey('unknown-action', [{ id: 'books', do: 'approve', checks: [{ name: 'x', path: 'books.is_error', equals: false }] }]),
    'unknown-matcher': journey('unknown-matcher', [{ ...call, checks: [{ name: 'x', path: 'books.is_error', is: false }] }]),
    'unknown-step': journey('unknown-step', [{ ...call, checks: [{ name: 'x', path: 'later.is_error', equals: false }] }]),
    'wrong-id': journey('another-id', [{ ...call, checks: [{ name: 'x', path: 'books.is_error', equals: false }] }]),
    'works': journey('works', [{ ...call, checks: [{ name: 'lists a book', path: 'books.data.books.length', equals: 1 }] }]),
  });
  const outcome = await runJourneys({ dir });
  const notes = Object.fromEntries(outcome.journeys.map((item) => [item.id, item.checks.map((check) => `${check.status} ${check.check}: ${check.note}`)]));
  assert.deepEqual(failing(outcome), ['broken-json', 'missing-fixture', 'missing-path', 'no-checks', 'unknown-action', 'unknown-matcher', 'unknown-step', 'wrong-id']);
  assert.ok(!resultRows(outcome).some((row) => row.status === 'SKIP'));
  assert.match(notes['broken-json'][0], /^FAIL journey loads: /);
  assert.match(notes['missing-fixture'][0], /^FAIL step books runs: .*absent\.md/);
  assert.ok(!notes['missing-fixture'][0].includes('rewrite-eval-'), 'temporary paths stay out of the results');
  assert.equal(notes['missing-fixture'][1], 'FAIL lists a book: not run: step books failed');
  assert.deepEqual(notes['missing-path'], ['FAIL reads a field: nothing at books.data.nothing.here']);
  assert.deepEqual(notes['no-checks'], ['FAIL journey loads: a journey must check something']);
  assert.match(notes['unknown-action'][0], /unknown action "approve"/);
  assert.match(notes['unknown-matcher'][0], /needs exactly one of equals, /);
  assert.match(notes['unknown-step'][0], /does not start at a step that already ran/);
  assert.match(notes['wrong-id'][0], /must match the file name "wrong-id"/);
  assert.deepEqual(notes.works, ['PASS lists a book: ']);
  assert.deepEqual(outcome.summary, { journeys: { pass: 1, fail: 8 }, checks: { pass: 1, fail: 9 } });
  await assert.rejects(runJourneys({ dir: tempDir() }), /no journeys in /);
});

test('compare reports regressions and fixes for common journeys only, and lists the rest as SKIP', () => {
  const before = results(
    run('approve', 'PASS', { refused: 'PASS', 'still proposed': 'PASS', retired: 'PASS' }),
    run('quote', 'FAIL', { rejected: 'FAIL' }),
    run('removed', 'FAIL', { anything: 'FAIL' }),
  );
  const after = results(
    run('added', 'FAIL', { anything: 'FAIL' }),
    run('approve', 'FAIL', { refused: 'FAIL', 'still proposed': 'PASS', fresh: 'FAIL' }),
    run('quote', 'PASS', { rejected: 'PASS' }),
  );
  const comparison = compareRuns(before, after);
  assert.deepEqual(comparison.rows, [
    { journey: 'added', check: '-', status: 'SKIP', note: 'only in after' },
    { journey: 'approve', check: 'refused', status: 'FAIL', note: 'regressed (was PASS): expected true' },
    { journey: 'approve', check: 'still proposed', status: 'PASS', note: 'unchanged' },
    { journey: 'approve', check: 'fresh', status: 'SKIP', note: 'only in after (FAIL)' },
    { journey: 'approve', check: 'retired', status: 'SKIP', note: 'only in before (PASS)' },
    { journey: 'quote', check: 'rejected', status: 'PASS', note: 'fixed (was FAIL)' },
    { journey: 'removed', check: '-', status: 'SKIP', note: 'only in before' },
  ]);
  assert.deepEqual([comparison.regressed, comparison.fixed, comparison.unchanged, comparison.skipped], [1, 1, 1, 4]);
  assert.equal(formatTable(comparison.rows.slice(0, 2)), [
    '| journey | check   | status | note                                |',
    '| ------- | ------- | ------ | ----------------------------------- |',
    '| added   | -       | SKIP   | only in after                       |',
    '| approve | refused | FAIL   | regressed (was PASS): expected true |',
  ].join('\n'));
});

test('npm run eval writes results.json, prints the table, and exits 1 only when a check fails', () => {
  const scratch = tempDir();
  const out = join(scratch, 'nested', 'results.json');
  const passing = evalCli('--out', out);
  assert.equal(passing.code, 0, passing.stderr);
  assert.match(passing.stdout, /^\| journey +\| check +\| status \| note \|$/m);
  assert.match(passing.stdout, /^\| agent-cannot-approve +\| accept_claim is refused +\| PASS +\|/m);
  assert.ok(passing.stdout.includes('journeys: 14 passed, 0 failed; checks: '));
  assert.ok(passing.stdout.includes(`results: ${out}`));
  const written = JSON.parse(readFileSync(out, 'utf8'));
  assert.equal(written.schema, RESULTS_SCHEMA);
  assert.deepEqual(written.summary.journeys, { pass: 14, fail: 0 });
  assert.equal(JSON.parse(readFileSync(resolve(import.meta.dirname, '..', 'package.json'), 'utf8')).scripts.eval, 'node scripts/eval.ts');

  const dir = journeyDir({ broken: journey('broken', [{ id: 'books', do: 'call', tool: 'list_books', checks: [{ name: 'no book is listed', path: 'books.data.books', equals: [] }] }]) });
  const failed = join(scratch, 'failed.json');
  const failingRun = evalCli('--journeys', dir, '--out', failed);
  assert.equal(failingRun.code, 1);
  assert.match(failingRun.stdout, /\| broken +\| no book is listed \| FAIL +\| expected \[\] +\|/);
  assert.deepEqual(JSON.parse(readFileSync(failed, 'utf8')).summary.journeys, { pass: 0, fail: 1 });

  mkdirSync(join(scratch, 'empty'));
  const empty = evalCli('--journeys', join(scratch, 'empty'), '--out', join(scratch, 'never.json'));
  assert.equal(empty.code, 1);
  assert.match(empty.stderr, /no journeys in /);
});

test('npm run eval -- --compare prints the comparison and exits 1 on a regression, 2 on bad usage', () => {
  const scratch = tempDir();
  const write = (name: string, value: unknown) => {
    writeFileSync(join(scratch, name), JSON.stringify(value));
    return join(scratch, name);
  };
  const good = write('good.json', results(run('approve', 'PASS', { refused: 'PASS' }), run('old', 'PASS', { x: 'PASS' })));
  const bad = write('bad.json', results(run('approve', 'FAIL', { refused: 'FAIL' })));

  const same = evalCli('--compare', good, good);
  assert.equal(same.code, 0, same.stderr);
  assert.ok(same.stdout.includes('before: 0.1.0 abc\nafter:  0.1.0 abc\n'));
  assert.ok(same.stdout.includes('0 regressed, 0 fixed, 2 unchanged, 0 skipped'));

  const regression = evalCli('--compare', good, bad);
  assert.equal(regression.code, 1);
  assert.match(regression.stdout, /\| approve \| refused \| FAIL +\| regressed \(was PASS\): expected true \|/);
  assert.match(regression.stdout, /\| old +\| - +\| SKIP +\| only in before +\|/);
  assert.ok(regression.stdout.includes('1 regressed, 0 fixed, 0 unchanged, 1 skipped'));

  const fix = evalCli('--compare', bad, good);
  assert.equal(fix.code, 0);
  assert.ok(fix.stdout.includes('0 regressed, 1 fixed, 0 unchanged, 1 skipped'));

  for (const args of [['--compare', good], ['--compare', good, join(scratch, 'absent.json')], ['--compare', good, write('other.json', { schema: 'x' })], ['--agent', 'claude-code'], ['--out']]) {
    const usage = evalCli(...args);
    assert.equal(usage.code, 2, args.join(' '));
    assert.match(usage.stderr, /^eval: .+\n\nUsage:/);
    assert.equal(usage.stdout, '');
  }
});
