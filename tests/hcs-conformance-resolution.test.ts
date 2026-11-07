import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { loadCases } from './hcs-cases.ts';
import { resolve } from '../src/hcs/resolve.ts';
import type { CatalogManifest } from '../src/hcs/catalog.ts';
import type { HostProfile } from '../src/hcs/host.ts';

const cases = loadCases('resolution', undefined);
test('pinned HCS resolution cases', { skip: cases ? false : 'HCS cases are not fetched' }, async t => {
  assert.ok(cases);
  t.diagnostic(`Resolution cases: ${cases.length}`);
  for (const { name, value } of cases) await t.test(name, () => {
    const { catalog, host } = value.input as { catalog: CatalogManifest; host: HostProfile };
    const expected = value.expect as unknown as { activationOrder: string[]; selected?: string[]; errors: {code: string; entry?: string; capability?: string}[] };
    const actual = resolve(catalog, host);
    assert.deepEqual(actual.activationOrder, expected.activationOrder);
    if (expected.selected !== undefined) assert.deepEqual(actual.selected, expected.selected);
    const remaining = actual.errors.slice();
    for (const error of expected.errors) {
      const index = remaining.findIndex(e => e.code === error.code && e.entry === error.entry && (error.capability === undefined || e.capability === error.capability));
      assert.notEqual(index, -1, `Missing ${JSON.stringify(error)} in ${JSON.stringify(remaining)}`);
      remaining.splice(index, 1);
    }
    assert.deepEqual(remaining, []);
  });
});
