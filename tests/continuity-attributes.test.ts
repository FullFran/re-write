import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Library } from '../src/application/library.ts';
import { buildMcpServer } from '../src/adapters/mcp.ts';
import type { ClaimView } from '../src/domain/claim.ts';
import { inspectContinuity } from '../src/domain/continuity.ts';
import { planted, plantedBook } from './attribute-fixtures.ts';
import { cli, git, tempDir } from './helpers.ts';

let seq = 0;
/** A current, accepted narrated fact about Elena; override what the case needs. */
function claim(quote: string, fields: Partial<ClaimView>): ClaimView {
  seq += 1;
  return {
    claim_id: `C-${seq}`,
    statement: quote,
    subject: 'Elena',
    source_file: `scenes/${String(seq).padStart(3, '0')}.md`,
    scope: 'book',
    epistemic_kind: 'narrated_fact',
    revision: 'r1',
    anchor: { quote, prefix: '', suffix: '', start: 0, end: quote.length } as any,
    extractor: 'test',
    editorial_status: 'accepted',
    history: [],
    evidence_status: 'valid',
    evidence_reason: 'exact',
    ...fields,
  };
}

const onBridge = (value: string | number, story_time?: number, extra: Partial<ClaimView> = {}) =>
  claim(`llevaba ${value} años en el puente (${seq})`, {
    attribute: { name: 'años_en', value, unit: 'años', about: 'puente de Sal' }, story_time, ...extra,
  });

test('a duration that shrinks as story time moves forward is a possible contradiction citing both quotes', () => {
  const first = onBridge('once', 1);
  const later = onBridge('nueve', 20);
  const findings = inspectContinuity([first, later]);
  assert.equal(findings.length, 1);
  const [f] = findings;
  assert.equal(f.kind, 'duration');
  assert.equal(f.method, 'rule:attribute-growth');
  assert.equal(f.classification, 'possible_contradiction');
  assert.equal((f as any).subject, 'Elena');
  assert.deepEqual(f.citations.map((c) => c.quote), [first.anchor.quote, later.anchor.quote]);
  assert.match(f.explanation, /11 años/);
  assert.match(f.explanation, /9 años/);
  assert.ok(f.explanation.includes(first.anchor.quote) && f.explanation.includes(later.anchor.quote));
  assert.ok(f.alternatives.some((a) => a.startsWith('mistake')));
  assert.ok(f.alternatives.some((a) => a.startsWith('time_jump')));
  assert.ok(f.alternatives.some((a) => a.startsWith('unreliable_narrator')));
  assert.match(f.finding_id, /^F-[0-9a-f]{10}$/);
  assert.equal(inspectContinuity([later, first])[0].finding_id, f.finding_id, 'the id does not depend on input order');
});

test('an age that grows with story time, or the same age written as a word and a digit, is not a contradiction', () => {
  const age = (value: string | number, story_time: number) =>
    claim(`tenía ${value} años (${seq})`, { attribute: { name: 'edad', value }, story_time });
  assert.deepEqual(inspectContinuity([age('nueve', 1), age(11, 30)]), []);
  assert.deepEqual(inspectContinuity([age('once', 1), age('11', 1)]), []);
});

test('two ages at the same story time that differ are a possible contradiction', () => {
  const findings = inspectContinuity([
    claim('tenía once años', { attribute: { name: 'edad', value: 'once' }, story_time: 3 }),
    claim('una niña de nueve años', { attribute: { name: 'edad', value: 9 }, story_time: 3 }),
  ]);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].kind, 'age');
  assert.equal(findings[0].classification, 'possible_contradiction');
  assert.match(findings[0].explanation, /same story time/);
});

test('without story time the order of two different durations is unknown, so it is not asserted as a contradiction', () => {
  const [f, ...rest] = inspectContinuity([onBridge('once', 1), onBridge('nueve')]);
  assert.equal(rest.length, 0);
  assert.equal(f.classification, 'insufficient_evidence');
  assert.match(f.explanation, /no story time/);
});

test('a stale quote lowers the finding to insufficient evidence', () => {
  const [f] = inspectContinuity([onBridge('once', 1), onBridge('nueve', 20, { evidence_status: 'stale' })]);
  assert.equal(f.classification, 'insufficient_evidence');
  assert.match(f.explanation, /stale/);
});

test('a fixed place that takes two values is a possible contradiction', () => {
  const place = (value: string, story_time: number) => claim(`la Casa del Peso, ${value} (${seq})`, {
    subject: 'Casa del Peso', attribute: { name: 'lugar', value }, story_time,
  });
  const sal = place('orilla de Sal', 6);
  const again = place('Orilla de sal', 9);
  const ribera = place('Ribera', 17);
  const findings = inspectContinuity([sal, again, ribera]);
  assert.equal(findings.length, 1);
  const [f] = findings;
  assert.equal(f.kind, 'place');
  assert.equal(f.method, 'rule:attribute-fixed');
  assert.equal(f.classification, 'possible_contradiction');
  assert.deepEqual(f.citations.map((c) => c.claim_id), [sal.claim_id, ribera.claim_id]);
  assert.match(f.explanation, /orilla de Sal/);
  assert.match(f.explanation, /Ribera/);
  assert.ok(f.alternatives.some((a) => a.startsWith('moved_or_rebuilt')));
});

test('two dates that run against story time are a possible contradiction', () => {
  const dated = (value: string, story_time: number) => claim(`aquel día de ${value} (${seq})`, {
    attribute: { name: 'fecha', value }, story_time,
  });
  const findings = inspectContinuity([dated('1888-03-04', 2), dated('1888-03', 3), dated('1888-02-27', 5)]);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].kind, 'date');
  assert.equal(findings[0].method, 'rule:date-order');
  assert.equal(findings[0].classification, 'possible_contradiction');
  assert.match(findings[0].explanation, /1888-02-27/);
  assert.deepEqual(inspectContinuity([dated('1888', 1), dated('1888-05-01', 2), dated('1889', 4)]), []);
});

test('a belief, rumor or other unnarrated claim that contradicts a narrated fact is not reported', () => {
  for (const epistemic_kind of ['belief', 'rumor', 'lie', 'inference'] as const) {
    assert.deepEqual(inspectContinuity([onBridge('once', 1), onBridge('nueve', 20, { epistemic_kind })]), []);
  }
  assert.deepEqual(inspectContinuity([onBridge('once', 1), onBridge('nueve', 20, { editorial_status: 'rejected' })]), []);
});

test('claims without attribute are not checked, and knowledge-order findings keep their ids', () => {
  const shown = claim('La llave está bajo la losa', { story_time: 1, knowledge: { holder: 'Elena', fact: 'key', mode: 'displays' } });
  const learned = claim('no había sabido nada', { story_time: 4, knowledge: { holder: 'Elena', fact: 'key', mode: 'acquires' } });
  const before = inspectContinuity([shown, learned]);
  assert.equal(before.length, 1);
  assert.equal(before[0].kind, 'knowledge_order');
  const after = inspectContinuity([shown, learned, claim('sin atributo', { story_time: 2 }), onBridge('once', 1), onBridge('nueve', 20)]);
  assert.deepEqual(after.filter((f) => f.kind === 'knowledge_order'), before);
});

test('annotation imports accept attribute and the check finds the planted age and place with verifiable quotes', () => {
  const dir = plantedBook();
  const path = join(tempDir(), 'annotations.json');
  writeFileSync(path, JSON.stringify({ extractor: 'fixture-annotations', candidates: planted }));
  const extracted = cli('extract', dir, '--from', path);
  assert.equal(extracted.code, 0);
  assert.equal(extracted.json.created.length, 4);
  const result = cli('check', dir);
  assert.equal(result.code, 0);
  assert.deepEqual(result.json.findings.map((f: any) => [f.kind, f.subject, f.classification]).sort(),
    [['duration', 'Elena', 'possible_contradiction'], ['place', 'Casa del Peso', 'possible_contradiction']]);
  for (const finding of result.json.findings) {
    for (const c of finding.citations) assert.ok(git(dir, 'show', `${c.revision}:${c.source_file}`).includes(c.quote));
  }
});

test('propose_claims accepts the optional attribute and inspect_continuity reports the contradiction', async () => {
  const data = tempDir();
  const book = join(data, 'books', 'sal');
  const planted0 = plantedBook();
  cli('init', book);
  cli('import', book, join(planted0, 'scenes/uno.md'), join(planted0, 'scenes/dos.md'));
  const lib = new Library(data);
  lib.grant('sal', 'user_fran');
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await buildMcpServer(lib, 'user_fran').connect(serverSide);
  const client = new Client({ name: 'test', version: '1' });
  await client.connect(clientSide);
  const proposed: any = await client.callTool({ name: 'propose_claims', arguments: { book: 'sal', extractor: 'x', candidates: planted.slice(0, 2) } });
  assert.ok(!proposed.isError);
  assert.equal(proposed.structuredContent.created.length, 2);
  const inspected: any = await client.callTool({ name: 'inspect_continuity', arguments: { book: 'sal' } });
  const [finding] = inspected.structuredContent.findings;
  assert.equal(inspected.structuredContent.total, 1);
  assert.equal(finding.kind, 'duration');
  assert.equal(finding.attribute, 'años_en');
  const badName: any = await client.callTool({ name: 'propose_claims', arguments: { book: 'sal', extractor: 'x', candidates: [{ ...planted[2], attribute: { name: 'peso', value: 1 } }] } });
  assert.equal(badName.isError, true, 'the schema refuses an unknown attribute name');
});
