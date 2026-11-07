import { test } from 'node:test';
import assert from 'node:assert/strict';
import { partitionMembers, stripExtensions, withExtensionsIgnored } from '../src/hcs/extensions.ts';

test('HCS-0000-R003 partitions valid extensions and reports invalid lookalikes', () => {
  assert.deepEqual(partitionMembers({ name: 'a', 'x-other': 1, 'x_bad': 2, 'x-Bad': 3 }), {
    core: { name: 'a' }, extensions: { 'x-other': 1 }, invalidExtensionNames: ['x_bad', 'x-Bad'],
  });
});

test('HCS-0000-R004 ignores unknown extensions at every depth without waiving core rules', () => {
  const validate = withExtensionsIgnored((doc: any) => ({ valid: doc.contentHash === 'expected' && doc.items[0].name === 'ok', errors: doc.contentHash === 'expected' ? [] : ['missing contentHash'] }));
  for (const base of [{ contentHash: 'expected', items: [{ name: 'ok' }] }, { items: [{ name: 'ok' }] }]) {
    const decorated = { ...base, 'x-waive': true, items: [{ ...base.items[0], 'x-unknown': { anything: 1 } }], 'x-extra': [1] };
    assert.deepEqual(stripExtensions(decorated), base);
    assert.deepEqual(validate(decorated), validate(base));
    assert.equal(validate(decorated).valid, 'contentHash' in base);
  }
});
