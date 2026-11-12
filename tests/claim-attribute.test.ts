import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { parseDate, parseSpanishNumber } from '../src/domain/claim-attribute.ts';
import { planted, plantedBook } from './attribute-fixtures.ts';
import { cli, tempDir } from './helpers.ts';

function extract(dir: string, candidates: object[]): any {
  const path = join(tempDir(), 'annotations.json');
  writeFileSync(path, JSON.stringify({ extractor: 'fixture-annotations', candidates }));
  return cli('extract', dir, '--from', path).json;
}

test('ages and durations read digits and simple Spanish number words', () => {
  assert.deepEqual(['once', '11', 11, 'Veintitrés', 'cuarenta y dos', 'ciento uno', 'cien', 'muchos', 'treinta y once', -1]
    .map(parseSpanishNumber), [11, 11, 11, 23, 42, 101, 100, null, null, null]);
  assert.deepEqual(['1888', '1888-03', '1888-03-04', 12, '1888-13', 'marzo'].map(parseDate),
    [[1888], [1888, 3], [1888, 3, 4], [12], null, null]);
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
    'attribute años_en needs a number of years, months, weeks or days, in digits or Spanish words: "muchos"',
    'unknown attribute: peso; expected one of edad, años_en, lugar, fecha',
    'attribute edad needs a number of years, months, weeks or days, in digits or Spanish words: "lustros"',
    'attribute fecha needs YYYY, YYYY-MM, YYYY-MM-DD or a number: "marzo"',
  ]);
  assert.deepEqual(cli('claims', dir).json.claims, []);
});
