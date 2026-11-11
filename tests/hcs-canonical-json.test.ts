import assert from 'node:assert/strict';
import test from 'node:test';
import { CanonicalError, canonicalize, parseStrictJson } from '../src/hcs/canonical-json.ts';

const refuses = (run: () => unknown, message: RegExp) => assert.throws(run, (error: unknown) => error instanceof CanonicalError && message.test(error.message));

test('canonicalize sorts members by UTF-16 code units and writes no whitespace', () => {
  // U+1F600 is the surrogate pair D83D DE00, which sorts before U+FB33 in UTF-16 and after it in code points.
  const value = { '\u{1f600}': 1, 'דּ': 2, b: [1, true, null, 'x'], a: { z: -5, y: 0 }, '': false };
  assert.equal(canonicalize(value), '{"":false,"a":{"y":0,"z":-5},"b":[1,true,null,"x"],"\u{1f600}":1,"דּ":2}');
});

test('canonicalize escapes only quotes, backslashes and control characters', () => {
  assert.equal(canonicalize('a"b\\c/\u0000\u001f\n\u007fé '), '"a\\"b\\\\c/\\u0000\\u001f\\n\u007fé "');
});

test('canonicalize writes integers of the safe range as decimal digits', () => {
  assert.equal(canonicalize([9007199254740991, -9007199254740991, 1e21 - 1e21, -0, 100]), '[9007199254740991,-9007199254740991,0,0,100]');
});

test('canonicalize refuses numbers that are not safe integers', () => {
  for (const value of [1.5, 9007199254740992, -9007199254740992, 1e21, Number.NaN, Number.POSITIVE_INFINITY]) {
    refuses(() => canonicalize({ n: value }), /not an integer/);
  }
});

test('canonicalize refuses unpaired surrogates in values and member names', () => {
  refuses(() => canonicalize(['\ud800']), /unpaired surrogate/);
  refuses(() => canonicalize({ '\udc00x': 1 }), /unpaired surrogate/);
});

test('canonicalize refuses values that are not JSON', () => {
  refuses(() => canonicalize({ a: undefined }), /not a JSON value/);
  refuses(() => canonicalize([1n]), /not a JSON value/);
  refuses(() => canonicalize(new Array(2)), /not a JSON value/);
  refuses(() => canonicalize(new Date(0)), /plain objects/);
  refuses(() => canonicalize([[[]]], 2), /depth limit/);
});

test('parseStrictJson reads what JSON.parse reads for a document of the canonical domain', () => {
  const text = ' {"a":[1,-2,0,true,false,null,"\\u00e9\\n\\ud83d\\ude00"],"b":{"__proto__":{"c":1}},"d":"","e":[],"f":{}} \n';
  const parsed = parseStrictJson(text);
  assert.deepEqual(parsed, JSON.parse(text));
  assert.equal(Object.hasOwn((parsed as { b: object }).b, '__proto__'), true);
  assert.deepEqual(parseStrictJson(new TextEncoder().encode(text)), JSON.parse(text));
});

test('parseStrictJson refuses a duplicated member name', () => {
  refuses(() => parseStrictJson('{"sequence":1,"sequence":2}'), /^Duplicated member name at offset 14$/);
  // The same name spelled with an escape is still the same name.
  refuses(() => parseStrictJson('{"a":{"k":1,"\\u006b":2}}'), /^Duplicated member name at offset 12$/);
});

test('parseStrictJson refuses an unpaired surrogate', () => {
  refuses(() => parseStrictJson('{"a":"\\ud800"}'), /unpaired surrogate/);
  refuses(() => parseStrictJson('{"\\udc00":1}'), /unpaired surrogate/);
});

test('parseStrictJson refuses numbers that are not safe integers', () => {
  for (const number of ['1.5', '9007199254740993', '1e400', '-9007199254740992']) {
    refuses(() => parseStrictJson(`{"n":${number}}`), /not an integer/);
  }
  assert.deepEqual(parseStrictJson('[1.0,1e2,-0]'), [1, 100, -0]);
});

test('parseStrictJson refuses text that is not one JSON document', () => {
  for (const text of ['', '{', '{"a":1,}', '[1 2]', '{"a" 1}', '{a:1}', '01', '"a\nb"', '"\\x"', 'nul', '{} {}', '﻿{}', "{'a':1}"]) {
    refuses(() => parseStrictJson(text), /offset/);
  }
  refuses(() => parseStrictJson(new Uint8Array([0x22, 0xff, 0x22])), /not valid UTF-8/);
});

test('parseStrictJson refuses nesting beyond the depth limit', () => {
  assert.deepEqual(parseStrictJson('[[1]]', 2), [[1]]);
  refuses(() => parseStrictJson('[[[1]]]', 2), /depth limit/);
  refuses(() => parseStrictJson('['.repeat(100_000)), /depth limit/);
});

test('parseStrictJson decides integrality from the exact decimal value of the token, without floating point', () => {
  // Each of these rounds to a safe integer as a double, and is not one.
  for (const number of ['1.0000000000000000001', '1e-400', '-1e-400', '9007199254740991.0000000000000001', '123e-1', '0.1e0', '9007199254740992.0', '900719925474099.2e1', '1e16', '1e99999999999999999999', '5e-99999999999999999999']) {
    assert.throws(() => parseStrictJson(`[${number}]`), (e: unknown) => e instanceof CanonicalError && e.outOfDomainNumber && /^Number is not an integer .* at offset 1$/.test(e.message), number);
  }
  // Spellings whose exact value is an integer in range are read as that integer.
  assert.deepEqual(parseStrictJson('[1.0,1e2,0.0000001e7,120e-1,0e99999999999999999999,0.000e-5,9007199254740991.0,900719925474099.1e1,-9007199254740991,-0.0]'), [1, 100, 1, 12, 0, 0, 9007199254740991, 9007199254740991, -9007199254740991, -0]);
});

test('error messages carry a position, never text of the document', () => {
  for (const text of ['{"secret-name":1,"secret-name":2}', '{"secret-name":"\\ud800"}', '{"secret-name":1.5}', '{"secret-name" 1}']) {
    assert.throws(() => parseStrictJson(text), (e: unknown) => e instanceof CanonicalError && !e.message.includes('secret') && /at offset [0-9]+$/.test(e.message), text);
  }
});
