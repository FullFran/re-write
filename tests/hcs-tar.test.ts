import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeTar, readTar } from '../src/hcs/tar.ts';

test('tar round trips sorted regular files and directories', () => {
  const bytes = writeTar([{ name: 'dir/file', data: Buffer.from('hello') }, { name: 'dir/', type: 'directory' }]);
  const entries = readTar(bytes);
  assert.deepEqual(entries.map(e => e.name), ['dir/', 'dir/file']);
  assert.equal(entries[1].data.toString(), 'hello');
});

test('tar rejects name and prefix fields with bytes hidden after NUL', () => {
  for (const offset of [0, 345]) {
    const tar = writeTar([{ name: 'safe' }]);
    tar.fill(0, offset, offset + (offset === 0 ? 100 : 155));
    tar.write('safe\0hidden', offset);
    tar.fill(32, 148, 156);
    tar.write(tar.subarray(0, 512).reduce((a, b) => a + b, 0).toString(8).padStart(6, '0') + '\0 ', 148, 8, 'ascii');
    assert.throws(() => readTar(tar));
  }
});
