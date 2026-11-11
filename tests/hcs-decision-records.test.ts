import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { DECISIONS_FILE, readDecisionLog, readDecisionRecords, validateDecisionRecord, writeDecisionRecord } from '../src/hcs/decision-records.ts';
import { tempDir } from './helpers.ts';

const record = {
  id: 'rec-1', time: '2026-11-07T15:40:02Z', entry: 'dev.example.a', permission: 'dev.example.mail.send',
  outcome: 'allow', operation: 'toolu_01', decider: { kind: 'grant', id: 'grant-9' }, channel: 'grant-store',
};

test('a decision record validates against the decisionRecord schema (HCS-0005-R011)', () => {
  assert.deepEqual(validateDecisionRecord(record), []);
  assert.deepEqual(validateDecisionRecord({ ...record, session: 's1', answer: 'allow_once', 'x-rewrite-note': { any: 1 }, time: '2026-11-07T15:40:02.123Z' }), []);
  const { operation: _operation, ...withoutOperation } = record;
  assert.deepEqual(validateDecisionRecord({ ...withoutOperation, outcome: 'revoked' }), [], 'a revocation needs no operation');
  assert.deepEqual(validateDecisionRecord(withoutOperation), ['/operation'], 'any other outcome needs one');
  // Members the schema does not define are refused, so arguments, results or content cannot ride along.
  assert.deepEqual(validateDecisionRecord({ ...record, arguments: { to: 'someone@example.com' } }), ['/arguments']);
  assert.deepEqual(validateDecisionRecord({ ...record, decider: { ...record.decider, note: 'x' } }), ['/decider/note']);
  const invalid: Array<[string, unknown, string]> = [
    ['id', '', '/id'], ['id', 'a'.repeat(257), '/id'], ['time', '2026-13-45T99:99:99Z', '/time'], ['time', '2026-11-07T15:40:02+01:00', '/time'],
    ['time', '2026-11-07T15:40:02Z\n', '/time'], ['entry', 'Not Dotted', '/entry'], ['permission', 'single', '/permission'],
    ['outcome', 'maybe', '/outcome'], ['operation', 7, '/operation'], ['session', '', '/session'], ['channel', '', '/channel'],
    ['answer', 'cancelled', '/answer'], ['decider', 'grant-9', '/decider'], ['decider', { kind: 'robot', id: 'x' }, '/decider/kind'],
    ['decider', { kind: 'grant' }, '/decider/id'],
  ];
  for (const [member, value, pointer] of invalid) assert.deepEqual(validateDecisionRecord({ ...record, [member]: value }), [pointer], `${member}=${JSON.stringify(value)}`);
  for (const member of ['id', 'time', 'entry', 'permission', 'outcome', 'decider', 'channel']) {
    const { [member]: _removed, ...rest } = record as Record<string, unknown>;
    assert.deepEqual(validateDecisionRecord(rest), [`/${member}`], `${member} is required`);
  }
  for (const value of [null, [], 'record', 1]) assert.deepEqual(validateDecisionRecord(value), ['']);
});

const fields = { entry: record.entry, permission: record.permission, outcome: 'allow', operation: 'call-1', decider: { kind: 'grant', id: 'grant-9' }, channel: 'grant-store' } as const;

test('the writer appends one schema-valid line per record, readable only by the host user (HCS-0005-R010, R011)', () => {
  const dir = join(tempDir(), 'data');
  const first = writeDecisionRecord(dir, fields);
  const second = writeDecisionRecord(dir, { ...fields, outcome: 'deny', decider: { kind: 'policy', id: 'HCS-0005-R001' }, session: 's1' });
  const lines = readFileSync(join(dir, DECISIONS_FILE), 'utf8').split('\n');
  assert.equal(lines.length, 3);
  assert.equal(lines[2], '');
  assert.deepEqual(lines.slice(0, 2).map(line => JSON.parse(line)), [first, second]);
  assert.deepEqual(readDecisionRecords(dir), [first, second]);
  assert.equal(statSync(join(dir, DECISIONS_FILE)).mode & 0o777, 0o600);
  const { id, time, ...rest } = first;
  assert.deepEqual(rest, fields);
  assert.match(time, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  assert.ok(Math.abs(Date.parse(time) - Date.now()) < 60_000);
  assert.notEqual(id, second.id);
  for (const written of [first, second]) assert.deepEqual(validateDecisionRecord(written), []);
});

test('the writer keeps only the members of the schema: operation content cannot reach the file (HCS-0005-R011)', () => {
  const dir = tempDir();
  const smuggled = { ...fields, arguments: { text: 'manuscript' }, result: 'manuscript', decider: { ...fields.decider, note: 'manuscript' }, 'x-content': 'manuscript' };
  writeDecisionRecord(dir, smuggled);
  assert.doesNotMatch(readFileSync(join(dir, DECISIONS_FILE), 'utf8'), /manuscript/);
  assert.deepEqual(Object.keys(readDecisionRecords(dir)[0]), ['id', 'time', 'entry', 'permission', 'outcome', 'operation', 'decider', 'channel']);
});

test('the writer refuses a record that does not validate and reports a store it cannot write', () => {
  const dir = tempDir();
  const { operation: _operation, ...withoutOperation } = fields;
  for (const invalid of [withoutOperation, { ...fields, operation: 'a'.repeat(257) }, { ...fields, entry: 'Not Dotted' }]) {
    assert.throws(() => writeDecisionRecord(dir, invalid), /Invalid decision record/);
  }
  assert.deepEqual(readDecisionRecords(dir), []);
  mkdirSync(join(dir, DECISIONS_FILE));
  assert.throws(() => writeDecisionRecord(dir, fields), /EISDIR/);
});

test('a torn last line costs only itself: the next record is a whole line and earlier records are still returned', () => {
  const dir = tempDir();
  const first = writeDecisionRecord(dir, fields);
  // A crash in the middle of a write leaves a partial line without its newline.
  appendFileSync(join(dir, DECISIONS_FILE), '{"id":"torn","time":"2026-11-0');
  const next = writeDecisionRecord(dir, { ...fields, operation: 'call-2' });
  assert.deepEqual(readDecisionLog(dir), { records: [first, next], invalid: [2] });
  assert.equal(readFileSync(join(dir, DECISIONS_FILE), 'utf8').split('\n').length, 4);
  // A line that parses but is not a decision record is reported the same way, by line number only.
  appendFileSync(join(dir, DECISIONS_FILE), '{"entry":"dev.example.a","arguments":"manuscript"}\n');
  const last = writeDecisionRecord(dir, { ...fields, operation: 'call-3' });
  assert.deepEqual(readDecisionLog(dir), { records: [first, next, last], invalid: [2, 4] });
  // The strict reader refuses to return a partial view without saying so.
  assert.throws(() => readDecisionRecords(dir), /2 invalid lines in decisions\.jsonl \(2, 4\)/);
  assert.deepEqual(readDecisionLog(tempDir()), { records: [], invalid: [] });
});
