import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { parseDate, parseSpanishNumber } from '../src/domain/claim-attribute.ts';
import { planted, plantedBook } from './attribute-fixtures.ts';
import { cli, git, tempDir } from './helpers.ts';

function extract(dir: string, candidates: object[]): any {
  const path = join(tempDir(), 'annotations.json');
  writeFileSync(path, JSON.stringify({ extractor: 'fixture-annotations', candidates }));
  return cli('extract', dir, '--from', path).json;
}

test('ages and durations read digits and simple Spanish number words', () => {
  assert.deepEqual(['once', '11', 11, 'Veintitrés', 'cuarenta y dos', 'ciento uno', 'cien', 'muchos', 'treinta y once', -1,
    '1.000', '1,5', 1.5, 1e300, '9'.repeat(150), 'doscientos', 200, 201]
    .map(parseSpanishNumber), [11, 11, 11, 23, 42, 101, 100, null, null, null, null, null, null, null, null, null, 200, null]);
  assert.deepEqual(['1888', '1888-03', '1888-03-04', 12, '1888-13', 'marzo', '1888-02-31', '1888-02-29', '1900-02-29', '2000-02-29', '1888-04-31', 1e300, 1.5]
    .map(parseDate), [[1888], [1888, 3], [1888, 3, 4], [12], null, null, null, [1888, 2, 29], null, [2000, 2, 29], null, null, null]);
});

test('annotation imports store the optional attribute as given, and claims without it are unchanged', () => {
  const dir = plantedBook();
  const { created } = extract(dir, [planted[3], { ...planted[2], attribute: undefined }]);
  assert.equal(created.length, 2);
  const claims = cli('claims', dir).json.claims;
  assert.deepEqual(claims.find((c: any) => c.anchor.quote.includes('Ribera')).attribute, { name: 'lugar', value: 'Ribera' });
  assert.equal('attribute' in claims.find((c: any) => c.anchor.quote.includes('orilla')), false);
});

test('an attribute that cannot be read is rejected with a reason, and nothing is stored', () => {
  const dir = plantedBook();
  const result = extract(dir, [
    { ...planted[0], attribute: { name: 'años_en', value: 'muchos' } },
    { ...planted[1], attribute: { name: 'peso', value: 3 } },
    { ...planted[2], attribute: { name: 'edad', value: 9, unit: 'lustros' } },
    { ...planted[3], attribute: { name: 'fecha', value: 'marzo' } },
  ]);
  assert.deepEqual(result.created, []);
  assert.deepEqual(result.rejected.map((r: any) => r.reason), [
    'attribute años_en needs a whole number from 0 to 200, in digits without separators or simple Spanish words: "muchos"',
    'unknown attribute: peso; expected one of edad, años_en, lugar, fecha',
    'attribute unit must be años, meses, semanas or días: "lustros"',
    'attribute fecha needs a real date as YYYY, YYYY-MM or YYYY-MM-DD, or a whole number: "marzo"',
  ]);
  assert.deepEqual(cli('claims', dir).json.claims, []);
});

/** Raw annotation text, so own keys such as __proto__ reach the import path exactly as written. */
function extractRaw(dir: string, attributes: string[]): any {
  const path = join(tempDir(), 'annotations.json');
  const candidates = attributes.map((attribute, i) => {
    const { attribute: _drop, ...rest } = planted[i % planted.length];
    return JSON.stringify(rest).replace(/}$/, `,"attribute":${attribute}}`);
  });
  writeFileSync(path, `{"extractor":"fixture-annotations","candidates":[${candidates.join(',')}]}`);
  return cli('extract', dir, '--from', path).json;
}

test('one validator refuses unreadable, oversized or unsafe attributes on the import path, with the invalid-input problem, and stores nothing', () => {
  const dir = plantedBook();
  const cases: [string, string][] = [
    ['{"name":"edad","value":1e300}', 'attribute edad needs a whole number from 0 to 200, in digits without separators or simple Spanish words: 1e+300'],
    [`{"name":"edad","value":"${'9'.repeat(150)}"}`, 'attribute value must be at most 120 characters'],
    ['{"name":"edad","value":"1.000"}', 'attribute edad needs a whole number from 0 to 200, in digits without separators or simple Spanish words: "1.000"'],
    ['{"name":"lugar","value":"Sal\\u0000\\u0007\\u001b[31m"}', 'attribute value must not contain control or format characters'],
    ['{"name":"lugar","value":"\\u0000\\u0001"}', 'attribute value must not contain control or format characters'],
    ['{"name":"lugar","value":"Ribera\\u200b"}', 'attribute value must not contain control or format characters'],
    [`{"name":"lugar","value":"${'x'.repeat(100_000)}"}`, 'attribute value must be at most 120 characters'],
    [`{"name":"años_en","value":3,"about":"${'x'.repeat(121)}"}`, 'attribute about must be at most 120 characters'],
    ['{"name":"lugar","value":"Ribera","extra":1}', 'attribute has unknown keys: extra; expected name, value, unit, about'],
    ['{"name":"lugar","value":"Ribera","__proto__":{"x":1}}', 'attribute has unknown keys: __proto__; expected name, value, unit, about'],
    ['{"name":"lugar","value":"Ribera","constructor":"x"}', 'attribute has unknown keys: constructor; expected name, value, unit, about'],
    ['{"name":"fecha","value":"1888-02-31"}', 'attribute fecha needs a real date as YYYY, YYYY-MM or YYYY-MM-DD, or a whole number: "1888-02-31"'],
    ['{"name":"lugar","value":"   "}', 'attribute value must not be empty'],
    ['["lugar","Ribera"]', 'attribute must be an object with name and value'],
  ];
  const result = extractRaw(dir, cases.map(([attribute]) => attribute));
  assert.deepEqual(result.created, []);
  assert.deepEqual(result.rejected.map((r: any) => r.reason), cases.map(([, reason]) => reason));
  for (const r of result.rejected) assert.match(r.problem.type, /#invalid-input$/);
  assert.deepEqual(cli('claims', dir).json.claims, []);
});

test('a valid attribute is stored with exactly its known keys, trimmed', () => {
  const dir = plantedBook();
  const result = extractRaw(dir, ['{"name":"años_en","value":" once ","unit":"años","about":" puente de Sal "}']);
  assert.equal(result.created.length, 1);
  assert.deepEqual(cli('claims', dir).json.claims[0].attribute, { name: 'años_en', value: 'once', unit: 'años', about: 'puente de Sal' });
});

test('proposing an existing claim again with an attribute attaches it, keeps its status and Canon, and commits once', () => {
  const dir = plantedBook();
  const bare = planted.map(({ attribute: _drop, ...rest }) => rest);
  const ids = extract(dir, bare).created;
  for (const id of ids) assert.equal(cli('review-claim', dir, id, 'accept', '--by', 'Reviewer').code, 0);
  assert.deepEqual(cli('check', dir).json.findings, [], 'claims without attribute are not checked');
  const canonBefore = cli('canon', dir).json.canon.map((c: any) => c.claim_id).sort();
  assert.equal(canonBefore.length, 4);
  const commits = Number(git(dir, 'rev-list', '--count', 'HEAD'));

  const result = extract(dir, planted);
  assert.deepEqual(result.created, []);
  assert.deepEqual(result.existing, []);
  assert.deepEqual([...result.attributed].sort(), [...ids].sort());
  assert.equal(Number(git(dir, 'rev-list', '--count', 'HEAD')), commits + 1, 'one commit for the call');
  const claims = cli('claims', dir).json.claims;
  for (const claim of claims) {
    const source = planted.find((p) => p.quote === claim.anchor.quote)!;
    assert.deepEqual(claim.attribute, source.attribute);
    assert.equal(claim.editorial_status, 'accepted');
    assert.equal(claim.history.length, 1, 'the editorial history is untouched');
    assert.equal(claim.attribute_history.length, 1);
    assert.equal(claim.attribute_history[0].by, 'fixture-annotations');
    assert.deepEqual(claim.attribute_history[0].attribute, source.attribute);
    assert.match(claim.attribute_history[0].at, /^\d{4}-\d{2}-\d{2}T/);
  }
  assert.deepEqual(cli('canon', dir).json.canon.map((c: any) => c.claim_id).sort(), canonBefore);
  assert.deepEqual(cli('check', dir).json.findings.map((f: any) => f.kind).sort(), ['duration', 'place']);

  const again = extract(dir, planted);
  assert.deepEqual([again.attributed, again.existing.length], [[], 4], 'the same attribute again is existing');
  const conflict = extract(dir, [{ ...planted[3], attribute: { name: 'lugar', value: 'orilla de Sal' } }]);
  assert.deepEqual([conflict.attributed, conflict.existing], [[], []]);
  assert.match(conflict.rejected[0].reason, /^attribute_conflict: claim C-[0-9a-f]{10} already has attribute \{"name":"lugar","value":"Ribera"\}/);
  assert.equal(Number(git(dir, 'rev-list', '--count', 'HEAD')), commits + 1, 'neither existing nor a conflict commits');
  const kept = cli('claims', dir).json.claims.find((c: any) => c.anchor.quote === planted[3].quote);
  assert.deepEqual(kept.attribute, planted[3].attribute);
  assert.equal(kept.attribute_history.length, 1);
});

test('over MCP an existing claim gains its attribute, a different one is a conflict, and unsafe attributes are refused', async () => {
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');
  const { Library } = await import('../src/application/library.ts');
  const { buildMcpServer } = await import('../src/adapters/mcp.ts');
  const data = tempDir();
  const book = join(data, 'books', 'sal');
  const scenes = plantedBook();
  cli('init', book);
  cli('import', book, join(scenes, 'scenes/uno.md'), join(scenes, 'scenes/dos.md'));
  const lib = new Library(data);
  lib.grant('sal', 'user_fran');
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await buildMcpServer(lib, 'user_fran').connect(serverSide);
  const client = new Client({ name: 'test', version: '1' });
  await client.connect(clientSide);
  const propose = async (candidates: object[]): Promise<any> =>
    client.callTool({ name: 'propose_claims', arguments: { book: 'sal', extractor: 'x', candidates } });

  const { attribute: _drop, ...bare } = planted[3];
  const [id] = (await propose([bare])).structuredContent.created;
  const attributed = (await propose([planted[3]])).structuredContent;
  assert.deepEqual([attributed.created, attributed.existing, attributed.attributed], [[], [], [id]]);
  const claim = (await client.callTool({ name: 'list_claims', arguments: { book: 'sal' } }) as any).structuredContent.claims[0];
  assert.deepEqual(claim.attribute, planted[3].attribute);
  assert.equal(claim.attribute_history[0].by, 'user_fran');

  const conflict = (await propose([{ ...planted[3], attribute: { name: 'lugar', value: 'orilla de Sal' } }])).structuredContent;
  const [refused] = conflict.rejected;
  assert.match(refused.reason, /^attribute_conflict: /);
  assert.equal(refused.problem.type, 'https://github.com/FullFran/re-write/blob/main/docs/problems.md#conflict');
  assert.equal(refused.problem.status, 409);
  assert.match(refused.next_step, /already has an attribute/);

  const unsafe = (await propose([{ ...planted[2], attribute: { name: 'lugar', value: 'Sal\u0000\u0007\u001b[31m' } }])).structuredContent;
  assert.equal(unsafe.rejected[0].reason, 'attribute value must not contain control or format characters');
  assert.equal(unsafe.rejected[0].problem.status, 400);
  const extra: any = await propose([{ ...planted[2], attribute: { name: 'lugar', value: 'Sal', extra: 1 } }]);
  assert.equal(extra.isError, true, 'the schema refuses unknown attribute keys');
  const total = (await client.callTool({ name: 'list_claims', arguments: { book: 'sal' } }) as any).structuredContent.total;
  assert.equal(total, 1);
});
