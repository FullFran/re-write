import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeTar, readTar, TarFormatError } from '../src/hcs/tar.ts';

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

// Writes `text` into a header field of the first member and fixes the checksum.
function patched(start: number, text: string): Buffer {
  const tar = writeTar([{ name: 'file', data: Buffer.from('hello') }]);
  tar.fill(0, start, start + 12); tar.write(text, start, 'ascii'); tar.fill(32, 148, 156);
  tar.write(tar.subarray(0, 512).reduce((a, b) => a + b, 0).toString(8).padStart(6, '0') + '\0 ', 148, 8, 'ascii');
  return tar;
}
function malformedTars(): [string, Buffer][] {
  const valid = () => writeTar([{ name: 'file', data: Buffer.from('hello') }]);
  const checksum = valid(); checksum[0] ^= 1;
  const terminator = valid(); terminator[terminator.length - 1] = 1;
  return [
    ['invalid checksum', checksum],
    ['truncated archive', valid().subarray(0, 1023)],
    ['invalid terminator', terminator],
    ['missing terminator', valid().subarray(0, 1024)],
    ['invalid numeric field', patched(124, 'zz')],
    ['truncated member', patched(124, '7777')],
  ];
}

test('a malformed archive is refused with a TarFormatError that names the reason', () => {
  for (const [reason, tar] of malformedTars()) {
    assert.throws(() => readTar(tar), (error: unknown) => {
      assert.ok(error instanceof TarFormatError, `${reason}: ${String(error)}`);
      assert.equal(error.reason, reason);
      assert.match(error.message, /^(Invalid tar|Truncated tar|Missing tar|Tar numeric)/);
      return true;
    }, reason);
  }
});
