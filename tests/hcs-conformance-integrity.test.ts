import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { loadCases } from './hcs-cases.ts';
import { HcsFailure } from '../src/hcs/errors.ts';
import { verifyPackage, type PackageExpected } from '../src/hcs/package.ts';

const cases = loadCases('integrity', undefined);
test('pinned HCS integrity cases', async t => {
  assert.ok(cases.length > 0, 'No integrity cases found');
  t.diagnostic(`Integrity cases: ${cases.length}`);
  for (const { name, value } of cases) await t.test(name, () => {
    const { entry, contentBase64 } = value.input as { entry: PackageExpected; contentBase64: string };
    assert.equal(typeof contentBase64, 'string');
    const verify = () => verifyPackage(Buffer.from(contentBase64, 'base64'), entry);
    if (value.expect.outcome === 'valid') {
      assert.doesNotThrow(verify);
    } else {
      assert.equal(value.expect.outcome, 'invalid');
      assert.throws(verify, (error: unknown) => {
        assert.ok(error instanceof HcsFailure);
        assert.deepEqual(error.errors.map(e => e.code), value.expect.errors?.map(e => e.code));
        return true;
      });
    }
  });
});
