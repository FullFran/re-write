import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { appendFileSync, chmodSync, mkdirSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { DECISION_LOG_MAX_BYTES, DECISIONS_FILE, listDecisionLogs, readAllDecisionLogs, readDecisionLog, readDecisionRecords, validateDecisionRecord, writeDecisionRecord } from '../src/hcs/decision-records.ts';
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

const ROTATED = /^decisions-\d{8}T\d{6}\.\d{3}Z(-\d+)?\.jsonl$/;
const logFiles = (dir: string) => readdirSync(dir).filter(name => name.endsWith('.jsonl')).sort();

test('a full log is renamed to decisions-<UTC timestamp>.jsonl and a new one is started; no record is deleted', () => {
  const dir = tempDir();
  assert.equal(DECISION_LOG_MAX_BYTES, 16 * 1024 * 1024, 'the default bound is 16 MiB');
  const first = writeDecisionRecord(dir, fields, { maxBytes: 1 });
  const before = Date.now();
  const second = writeDecisionRecord(dir, { ...fields, operation: 'call-2' }, { maxBytes: 1 });
  const third = writeDecisionRecord(dir, { ...fields, operation: 'call-3' }, { maxBytes: 1 });
  const files = logFiles(dir);
  assert.equal(files.length, 3);
  assert.equal(files.filter(name => ROTATED.test(name)).length, 2);
  assert.ok(files.includes(DECISIONS_FILE));
  for (const name of files) assert.equal(statSync(join(dir, name)).mode & 0o777, 0o600, name);
  const stamp = /^decisions-(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})\.(\d{3})Z/.exec(files.find(name => ROTATED.test(name))!)!;
  const rotatedAt = Date.UTC(+stamp[1], +stamp[2] - 1, +stamp[3], +stamp[4], +stamp[5], +stamp[6], +stamp[7]);
  assert.ok(rotatedAt >= before - 1 && rotatedAt <= Date.now(), 'the name is the UTC time of the rotation');
  // The current file holds only what was written after the last rotation; nothing else changed.
  assert.deepEqual(readDecisionLog(dir), { records: [third], invalid: [] });
  assert.deepEqual(readAllDecisionLogs(dir), { records: [first, second, third], invalid: [] });
  // Rotation order, not name order: decisions-<t>.jsonl was rotated before decisions-<t>-1.jsonl.
  const listed = listDecisionLogs(dir);
  assert.deepEqual([...listed].sort(), files);
  assert.equal(listed.at(-1), DECISIONS_FILE);
  assert.deepEqual(listed.map(name => readFileSync(join(dir, name), 'utf8')).join('').trim().split('\n').map(line => JSON.parse(line)), [first, second, third]);
  // Under the bound nothing rotates, whatever the size of the file.
  writeDecisionRecord(dir, { ...fields, operation: 'call-4' });
  assert.equal(logFiles(dir).length, 3);
});

test('the operator sets the bound with REWRITE_DECISIONS_MAX_BYTES; an invalid value is refused', () => {
  const dir = tempDir();
  const saved = process.env.REWRITE_DECISIONS_MAX_BYTES;
  try {
    process.env.REWRITE_DECISIONS_MAX_BYTES = '1';
    writeDecisionRecord(dir, fields);
    writeDecisionRecord(dir, fields);
    assert.equal(logFiles(dir).length, 2);
    for (const value of ['0', '-5', 'big', '1.5']) {
      process.env.REWRITE_DECISIONS_MAX_BYTES = value;
      assert.throws(() => writeDecisionRecord(dir, fields), /REWRITE_DECISIONS_MAX_BYTES/, value);
    }
  } finally {
    if (saved === undefined) delete process.env.REWRITE_DECISIONS_MAX_BYTES; else process.env.REWRITE_DECISIONS_MAX_BYTES = saved;
  }
  assert.equal(readAllDecisionLogs(dir).records.length, 2, 'a refused bound writes nothing');
});

// Root ignores directory permissions, so a read-only directory cannot make the rename fail for it.
test('a log that cannot be rotated fails closed: the record is not written and the writer throws (HCS-0005-R012)', { skip: process.getuid?.() === 0 ? 'running as root' : false }, () => {
  const dir = join(tempDir(), 'data');
  const first = writeDecisionRecord(dir, fields);
  chmodSync(dir, 0o500);
  try {
    assert.throws(() => writeDecisionRecord(dir, fields, { maxBytes: 1 }), /EACCES/);
  } finally { chmodSync(dir, 0o700); }
  assert.deepEqual(logFiles(dir), [DECISIONS_FILE]);
  assert.deepEqual(readAllDecisionLogs(dir), { records: [first], invalid: [] });
});

test('two processes writing and rotating the same directory lose and corrupt no record', async () => {
  const dir = tempDir();
  const module = join(import.meta.dirname, '../src/hcs/decision-records.ts');
  const perWriter = 300;
  const script = `
    const { writeDecisionRecord } = await import(${JSON.stringify(module)});
    const [dir, name, count] = process.argv.slice(1);
    for (let i = 0; i < Number(count); i++) {
      writeDecisionRecord(dir, { entry: 'dev.example.a', permission: 'dev.example.mail.send', outcome: 'allow',
        operation: name + '-' + i, decider: { kind: 'grant', id: 'grant-9' }, channel: 'grant-store' }, { maxBytes: 4096 });
    }`;
  const run = (name: string) => new Promise<number | null>((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', script, dir, name, String(perWriter)], { stdio: ['ignore', 'ignore', 'inherit'] });
    child.on('error', reject);
    child.on('exit', resolve);
  });
  assert.deepEqual(await Promise.all([run('cli'), run('server')]), [0, 0]);
  const files = logFiles(dir);
  assert.ok(files.length > 10, `${files.length} files: the writers rotated many times`);
  for (const name of files) {
    assert.ok(name === DECISIONS_FILE || ROTATED.test(name), name);
    assert.equal(statSync(join(dir, name)).mode & 0o777, 0o600, name);
  }
  const { records, invalid } = readAllDecisionLogs(dir);
  assert.deepEqual(invalid, []);
  const operations = records.map(r => r.operation).sort();
  const expected = ['cli', 'server'].flatMap(name => Array.from({ length: perWriter }, (_, i) => `${name}-${i}`)).sort();
  assert.deepEqual(operations, expected, 'every record is present exactly once');
  // Each writer's own records stay in the order it wrote them.
  for (const name of ['cli', 'server']) {
    const own = records.filter(r => r.operation!.startsWith(`${name}-`)).map(r => Number(r.operation!.split('-')[1]));
    assert.deepEqual(own, Array.from({ length: perWriter }, (_, i) => i), name);
  }
});
