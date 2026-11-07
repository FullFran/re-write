import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluate, type Check, type Denial, type Grant } from '../src/hcs/authority.ts';
import { loadCases } from './hcs-cases.ts';

interface AuthorityCase { requests: unknown[]; grants: Grant[]; denials?: Denial[]; check: Check }
interface AuthorityExpect { decision: { allow: boolean; error?: { code: string } } }

const cases = loadCases('authority', undefined);
test('pinned HCS authority cases', async t => {
  assert.ok(cases.length > 0, 'authority cases are present');
  t.diagnostic(`Authority cases: ${cases.length}`);
  for (const { name, value } of cases) await t.test(name, () => {
    const input = value.input as AuthorityCase;
    const expected = (value.expect as unknown as AuthorityExpect).decision;
    // Requests are part of the case input but never reach the evaluator (HCS-0005-R002, R004).
    const decision = evaluate(input.check, input.grants, input.denials);
    assert.equal(decision.allow, expected.allow);
    if (!decision.allow) {
      assert.equal(decision.error.code, expected.error?.code);
      assert.equal(decision.error.entry, input.check.entry);
    }
  });
});
