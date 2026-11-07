import assert from 'node:assert/strict';
import { test } from 'node:test';
import { builtinCapabilities, dispatch } from '../src/hcs/capabilities.ts';
import { REWRITE_HOST } from '../src/hcs/host.ts';
import { HcsFailure } from '../src/hcs/errors.ts';

const ref = 'com.fullfran.rewrite.book.read@1';
test('builtins snapshot and dispatch enforce active and draining capabilities', () => {
  const snapshot = builtinCapabilities().snapshot();
  assert.equal(snapshot.generation, null);
  assert.deepEqual([...snapshot.active], REWRITE_HOST.builtins);
  assert.ok(snapshot.active.has('com.fullfran.rewrite.continuity.check@1'));
  assert.doesNotThrow(() => dispatch(snapshot, ref));
  for (const draining of [false, true]) {
    assert.throws(() => dispatch({ generation: 1, active: new Set(), draining: new Set(draining ? [ref] : []) }, ref), (e: unknown) => {
      assert.ok(e instanceof HcsFailure);
      assert.equal(e.errors[0].code, 'unsupported_capability');
      assert.equal(e.errors[0].capability, ref);
      assert.equal(e.errors[0].requirement, draining ? 'HCS-0004-R006' : 'HCS-0004-R005');
      return true;
    });
  }
});
