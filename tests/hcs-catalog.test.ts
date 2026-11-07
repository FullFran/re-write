import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readCatalog } from '../src/hcs/catalog.ts';

const entry = () => ({ id: 'dev.example.a', version: '1', contentHash: `sha256:${'a'.repeat(64)}`, size: 0, mediaType: 'application/octet-stream', contributions: [{ kind: 'skill', path: 'skill' }] });
const catalog = () => ({ hcsVersion: '0.1', id: 'dev.example.catalog', version: '1', entries: [entry()] });
const errors = (input: unknown) => { const result = readCatalog(JSON.stringify(input)); assert.equal(result.ok, false); return result.ok ? [] : result.errors; };

test('unknown version precedes structural validation', () => { assert.deepEqual(errors({ hcsVersion: '9', entries: 'broken' }).map(e => e.code), ['unsupported_hcs_version']); });
test('every repeated entry is reported', () => { const doc = catalog(); doc.entries.push(entry(), entry()); assert.deepEqual(errors(doc).map(e => [e.code, e.entry]), [['duplicate_entry', 'dev.example.a'], ['duplicate_entry', 'dev.example.a']]); });
test('size and depth are checked before parse', () => { assert.equal(readCatalog(' '.repeat(4_194_305)).ok, false); assert.equal(readCatalog('['.repeat(65)).ok, false); });
test('paths must be relative POSIX paths', () => { for (const path of ['../a', '/a', 'a\\b']) { const doc = catalog(); doc.entries[0].contributions[0].path = path; assert.equal(errors(doc)[0].code, 'manifest_invalid'); } });
test('valid catalog passes document validation', () => { assert.equal(readCatalog(JSON.stringify(catalog())).ok, true); });
test('dotted identifiers respect the schema length limit', () => { const doc = catalog(); doc.id = `dev.${'a'.repeat(125)}`; assert.equal(errors(doc)[0].code, 'manifest_invalid'); });
test('depth boundary respects quoted delimiters', () => { const nested = (n: number) => `{"hcsVersion":"0.1","id":"dev.example.a","version":"1","entries":[],"x-test":${'['.repeat(n)}"[\\\""${']'.repeat(n)}}`; assert.equal(readCatalog(nested(63)).ok, true); assert.equal(readCatalog(nested(64)).ok, false); });
