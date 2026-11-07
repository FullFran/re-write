// HCS conformance of re-write, measured: every case of the vendored release (vendor/hcs/<version>/index.json) is
// fed to the re-write code that owns it and classified pass, fail, not-applicable or known divergence.
// tests/hcs-conformance.test.ts runs it and fails only on a regression against baseline.json; docs/hcs.md explains it.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { evaluate as evaluateAuthority, type Check, type Denial, type Grant } from '../../../src/hcs/authority.ts';
import { readCatalog, type CatalogManifest } from '../../../src/hcs/catalog.ts';
import { HcsFailure } from '../../../src/hcs/errors.ts';
import type { HostProfile } from '../../../src/hcs/host.ts';
import { validateEntryStatus } from '../../../src/hcs/lifecycle.ts';
import { verifyPackage, type PackageExpected } from '../../../src/hcs/package.ts';
import { resolve as resolveCatalog } from '../../../src/hcs/resolve.ts';
import { readPin, releaseDir } from '../../../src/hcs/vendor.ts';

export const ROOT = resolve(import.meta.dirname, '..', '..', '..');
export const POLICY_FILE = join(ROOT, 'tests', 'fixtures', 'hcs', 'divergences.json');
export const BASELINE_FILE = join(ROOT, 'tests', 'fixtures', 'hcs', 'baseline.json');
export const STATUSES = ['pass', 'fail', 'not-applicable', 'divergence'] as const;
export type Status = typeof STATUSES[number];

export interface IndexCase { path: string; requirements: string[]; level: string; polarity: string }
export interface HcsCase { level: string; target?: string; input: unknown; expect: Record<string, unknown> }
export interface Rule { requirement: string; cases?: string[]; reason: string }
export interface Policy { divergences: Rule[]; notApplicable: Rule[] }
export interface Result { status: Status | 'unclassified'; reason: string }
export interface Baseline { version: string; cases: Record<string, string> }

type ExpectedError = { code: string; entry?: string; capability?: string };

// One runner per level and target that re-write implements. Each asserts the case's `expect` against re-write's
// verdict; an assertion failure is the case's `fail` reason. Levels and targets without a runner are not applicable.
const runners: Record<string, (value: HcsCase) => void> = {
  'document urn:hcs:schema:hcs-0001:catalog-manifest:0.1': value => {
    const result = readCatalog(JSON.stringify(value.input));
    assert.equal(result.ok ? 'valid' : 'invalid', value.expect.outcome);
    for (const expected of (value.expect.errors ?? []) as ExpectedError[]) {
      assert.ok(!result.ok && result.errors.some(error => error.code === expected.code && (expected.entry === undefined || error.entry === expected.entry)), `missing expected error ${expected.code}`);
    }
  },
  'document urn:hcs:schema:hcs-0004:lifecycle:0.1': value => {
    assert.equal(validateEntryStatus(value.input).length === 0 ? 'valid' : 'invalid', value.expect.outcome);
  },
  integrity: value => {
    const { entry, contentBase64 } = value.input as { entry: PackageExpected; contentBase64: string };
    assert.equal(typeof contentBase64, 'string');
    const verify = () => verifyPackage(Buffer.from(contentBase64, 'base64'), entry);
    if (value.expect.outcome === 'valid') { assert.doesNotThrow(verify); return; }
    assert.equal(value.expect.outcome, 'invalid');
    assert.throws(verify, (error: unknown) => {
      assert.ok(error instanceof HcsFailure);
      assert.deepEqual(error.errors.map(e => e.code), (value.expect.errors as ExpectedError[] | undefined)?.map(e => e.code));
      return true;
    });
  },
  resolution: value => {
    const { catalog, host } = value.input as { catalog: CatalogManifest; host: HostProfile };
    const expected = value.expect as { activationOrder: string[]; selected?: string[]; errors: ExpectedError[] };
    const actual = resolveCatalog(catalog, host);
    assert.deepEqual(actual.activationOrder, expected.activationOrder);
    if (expected.selected !== undefined) assert.deepEqual(actual.selected, expected.selected);
    const remaining = actual.errors.slice();
    for (const error of expected.errors) {
      const index = remaining.findIndex(e => e.code === error.code && e.entry === error.entry && (error.capability === undefined || e.capability === error.capability));
      assert.notEqual(index, -1, `missing ${JSON.stringify(error)} in ${JSON.stringify(remaining)}`);
      remaining.splice(index, 1);
    }
    assert.deepEqual(remaining, []);
  },
  authority: value => {
    // Requests are part of the case input but never reach the evaluator (HCS-0005-R002, R004).
    const input = value.input as { grants: Grant[]; denials?: Denial[]; check: Check };
    const expected = (value.expect as { decision: { allow: boolean; error?: { code: string } } }).decision;
    const decision = evaluateAuthority(input.check, input.grants, input.denials);
    assert.equal(decision.allow, expected.allow);
    if (!decision.allow) {
      assert.equal(decision.error.code, expected.error?.code);
      assert.equal(decision.error.entry, input.check.entry);
    }
  },
};

export const runnerFor = (value: HcsCase) => runners[`${value.level} ${value.target}`] ?? runners[value.level];

const readJson = <T>(file: string): T => JSON.parse(readFileSync(file, 'utf8')) as T;
export const readPolicy = () => readJson<Policy>(POLICY_FILE);
export const readBaseline = () => readJson<Baseline>(BASELINE_FILE);

/** The first rule (`{ requirement, cases?, reason }`) that covers the case; a rule without `cases` covers its whole requirement. */
export function matchRule(rules: Rule[], indexCase: IndexCase): Rule | undefined {
  return rules.find(rule => indexCase.requirements.includes(rule.requirement) && (rule.cases === undefined || rule.cases.includes(indexCase.path)));
}

export function classify(indexCase: IndexCase, value: HcsCase, policy: Policy): Result {
  const divergence = matchRule(policy.divergences, indexCase);
  if (divergence) return { status: 'divergence', reason: divergence.reason };
  const notApplicable = matchRule(policy.notApplicable, indexCase);
  if (notApplicable) return { status: 'not-applicable', reason: notApplicable.reason };
  if (value.level === 'host') return { status: 'not-applicable', reason: 'host-level case: needs a running host (reported pending upstream)' };
  const runner = runnerFor(value);
  if (!runner) return { status: 'not-applicable', reason: `re-write has no runner for level ${value.level}${value.target ? ` target ${value.target}` : ''}` };
  try { runner(value); return { status: 'pass', reason: '' }; }
  catch (error) { return { status: 'fail', reason: (error instanceof Error ? error.message : String(error)).split('\n')[0] }; }
}

/** Every case of the vendored release: `{ version, cases, results: { path: { status, reason } } }`. */
export function measure(policy: Policy = readPolicy()) {
  const pin = readPin(ROOT);
  const dir = releaseDir(ROOT, pin);
  const cases = readJson<{ conformance: { cases: IndexCase[] } }>(join(dir, 'index.json')).conformance.cases;
  const results: Record<string, Result> = {};
  for (const indexCase of cases) results[indexCase.path] = classify(indexCase, readJson<HcsCase>(join(dir, indexCase.path)), policy);
  return { version: pin.version, cases, results };
}

/** Per level, the count of each status. */
export function summarize({ cases, results }: ReturnType<typeof measure>): Record<string, Record<string, number>> {
  const summary: Record<string, Record<string, number>> = {};
  for (const { path, level } of cases) {
    summary[level] ??= Object.fromEntries(STATUSES.map(status => [status, 0]));
    summary[level][results[path].status] = (summary[level][results[path].status] ?? 0) + 1;
  }
  return summary;
}

/** Cases that pass in `baseline` and do not pass in `results`. */
export function regressions(baseline: Baseline, results: Record<string, Result>) {
  return Object.entries(baseline.cases)
    .filter(([path, status]) => status === 'pass' && results[path]?.status !== 'pass')
    .map(([path]) => ({ path, now: results[path]?.status ?? 'missing', reason: results[path]?.reason ?? 'the case is no longer in the release' }));
}

export const baselineOf = ({ version, results }: { version: string; results: Record<string, Result> }): Baseline => ({
  version,
  cases: Object.fromEntries(Object.keys(results).sort().map(path => [path, results[path].status])),
});
