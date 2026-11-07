import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readCatalog } from '../src/hcs/catalog.ts';
import { loadCases } from './hcs-cases.ts';

const cases = loadCases('document', 'urn:hcs:schema:hcs-0001:catalog-manifest:0.1');
if (!cases) test('HCS document cases (run npm run hcs:fetch)', { skip: 'Run npm run hcs:fetch to load pinned cases' }, () => {});
else {
  test('targeted document cases are present', () => assert.ok(cases.length > 0));
  for (const { name, value } of cases) test(`HCS document: ${name}`, () => {
    const result = readCatalog(JSON.stringify(value.input));
    assert.equal(result.ok ? 'valid' : 'invalid', value.expect.outcome);
    for (const expected of value.expect.errors ?? []) {
      assert.ok(!result.ok && result.errors.some(error => error.code === expected.code && (expected.entry === undefined || error.entry === expected.entry)), `missing expected error ${expected.code}`);
    }
  });
}
