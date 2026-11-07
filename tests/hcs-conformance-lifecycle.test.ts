import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateEntryStatus } from '../src/hcs/lifecycle.ts';
import { loadCases } from './hcs-cases.ts';

const cases = loadCases('document', 'urn:hcs:schema:hcs-0004:lifecycle:0.1');
test('pinned HCS lifecycle document cases', async t => {
  assert.ok(cases.length > 0, 'targeted lifecycle cases are present');
  t.diagnostic(`Lifecycle document cases: ${cases.length}`);
  for (const { name, value } of cases) await t.test(name, () => {
    assert.equal(validateEntryStatus(value.input).length === 0 ? 'valid' : 'invalid', value.expect.outcome);
  });
});
