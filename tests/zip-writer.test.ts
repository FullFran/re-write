import assert from 'node:assert/strict';
import { test } from 'node:test';
import { deflateRawSync } from 'node:zlib';
import { computeCrc32, readZip, writeZip } from '../src/adapters/zip.ts';

test('writeZip output is read back by readZip, byte for byte, names with accents included', () => {
  const entries = [
    { name: 'a.txt', data: Buffer.from('hello hello hello hello') },
    { name: 'dir/ñandú.xml', data: Buffer.from('<x>ñ</x>', 'utf8') },
    { name: 'empty.txt', data: Buffer.alloc(0) },
  ];
  const read = readZip(writeZip(entries));
  assert.deepEqual(read.map((e) => e.name), entries.map((e) => e.name));
  assert.deepEqual(read.map((e) => e.getData().toString('utf8')), entries.map((e) => e.data.toString('utf8')));
});

test('writeZip is deterministic', () => {
  const entries = [{ name: 'a', data: Buffer.from('x'.repeat(500)) }];
  assert.ok(writeZip(entries).equals(writeZip(entries)));
});

test('the zip reader still reads a hand-built archive as before', () => {
  const data = Buffer.from('legacy member');
  const raw = deflateRawSync(data);
  const name = Buffer.from('m.txt');
  const crc = computeCrc32(data);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(8, 8);
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(raw.length, 18);
  local.writeUInt32LE(data.length, 22);
  local.writeUInt16LE(name.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(8, 10);
  central.writeUInt32LE(crc, 16);
  central.writeUInt32LE(raw.length, 20);
  central.writeUInt32LE(data.length, 24);
  central.writeUInt16LE(name.length, 28);
  const cdOffset = 30 + name.length + raw.length;
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(46 + name.length, 12);
  end.writeUInt32LE(cdOffset, 16);
  const [entry] = readZip(Buffer.concat([local, name, raw, central, name, end]));
  assert.equal(entry.name, 'm.txt');
  assert.equal(entry.getData().toString(), 'legacy member');
});
