// HCS conformance of re-write (docs/hcs.md): every case of the vendored release is classified pass, fail,
// not-applicable or known divergence. The test fails only on a regression: a case that passes in
// tests/fixtures/hcs/baseline.json and does not pass now. After an intended change (a fix, or a new HCS release):
//   HCS_BASELINE=write node --test tests/hcs-conformance.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { BASELINE_FILE, STATUSES, baselineOf, classify, measure, readBaseline, readPolicy, regressions, summarize, type HcsCase, type IndexCase } from './fixtures/hcs/conformance.ts';

const measured = measure();
if (process.env.HCS_BASELINE === 'write') writeFileSync(BASELINE_FILE, `${JSON.stringify(baselineOf(measured), null, 2)}\n`);

test('reports the conformance per level', t => {
  const summary = summarize(measured);
  t.diagnostic(`HCS ${measured.version} conformance of re-write`);
  for (const [level, counts] of Object.entries(summary)) t.diagnostic(`${level.padEnd(13)} ${STATUSES.map(status => `${status} ${counts[status]}`).join(', ')}`);
  for (const status of ['fail', 'divergence'] as const) {
    for (const [path, result] of Object.entries(measured.results)) if (result.status === status) t.diagnostic(`${status}: ${path.replace(/^conformance\/cases\//, '')}: ${result.reason}`);
  }
  assert.ok(Object.values(measured.results).some(result => result.status === 'pass'), 'no case passes: the runners are not wired');
});

test('every case is classified: none is silently skipped', () => {
  assert.deepEqual(Object.entries(measured.results).filter(([, result]) => !(STATUSES as readonly string[]).includes(result.status)), []);
});

test('no case that passed in the baseline fails now', () => {
  const baseline = readBaseline();
  assert.equal(baseline.version, measured.version, 'the baseline is for another HCS release: regenerate it with HCS_BASELINE=write');
  assert.deepEqual(regressions(baseline, measured.results), []);
});

test('every divergence and not-applicable rule names a requirement, a reason and cases of the vendored release', () => {
  const policy = readPolicy();
  for (const rule of [...policy.divergences, ...policy.notApplicable]) {
    assert.ok(rule.reason?.trim(), `${rule.requirement}: a rule needs a reason`);
    const covered = measured.cases.filter(c => c.requirements.includes(rule.requirement) && (rule.cases === undefined || rule.cases.includes(c.path)));
    assert.ok(covered.length > 0, `${rule.requirement}: the rule matches no case of the vendored release`);
    for (const path of rule.cases ?? []) assert.ok(covered.some(c => c.path === path), `${path}: not a case of ${rule.requirement}`);
  }
});

test('a case that passed in the baseline and does not pass now is a regression', () => {
  const baseline = { version: 'x', cases: { a: 'pass', b: 'fail', c: 'pass', d: 'pass' } };
  const now = { a: { status: 'pass' as const, reason: '' }, b: { status: 'pass' as const, reason: '' }, c: { status: 'fail' as const, reason: 'errors differ' } };
  assert.deepEqual(regressions(baseline, now), [
    { path: 'c', now: 'fail', reason: 'errors differ' },
    { path: 'd', now: 'missing', reason: 'the case is no longer in the release' },
  ]);
});

test('rules win over runners, and host cases or levels without a runner are not applicable', () => {
  const indexCase: IndexCase = { path: 'p', requirements: ['HCS-0005-R001'], level: 'authority', polarity: 'invalid' };
  const failing: HcsCase = { level: 'authority', input: { grants: [], check: { entry: 'a.b', permission: 'a.b.c' } }, expect: { decision: { allow: true } } };
  assert.equal(classify(indexCase, failing, { divergences: [], notApplicable: [] }).status, 'fail');
  assert.deepEqual(classify(indexCase, failing, { divergences: [{ requirement: 'HCS-0005-R001', reason: 'on purpose' }], notApplicable: [] }), { status: 'divergence', reason: 'on purpose' });
  assert.deepEqual(classify(indexCase, failing, { divergences: [], notApplicable: [{ requirement: 'HCS-0005-R001', cases: ['p'], reason: 'not built' }] }), { status: 'not-applicable', reason: 'not built' });
  assert.equal(classify(indexCase, failing, { divergences: [], notApplicable: [{ requirement: 'HCS-0005-R001', cases: ['other'], reason: 'x' }] }).status, 'fail');
  assert.equal(classify({ ...indexCase, level: 'host' }, { ...failing, level: 'host' }, { divergences: [], notApplicable: [] }).status, 'not-applicable');
  assert.match(classify({ ...indexCase, level: 'client' }, { ...failing, level: 'client' }, { divergences: [], notApplicable: [] }).reason, /no runner for level client/);
});
