import { closeSync, fstatSync, fsyncSync, linkSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, renameSync, statSync, unlinkSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { isDottedId, isExtensionName } from './ids.ts';

// HCS-0005 section 3.3: what the host writes for each permission decision it acts on and for each
// grant it removes. A record names the operation, never its arguments, its result or any content.
export const DECISION_OUTCOMES = ['allow', 'deny', 'timeout', 'error', 'revoked'] as const;
export const DECIDER_KINDS = ['subject', 'grant', 'denial', 'policy'] as const;
export const ANSWERS = ['allow_once', 'allow_always', 'reject_once', 'reject_always'] as const;

export interface Decider { kind: (typeof DECIDER_KINDS)[number]; id: string }
export interface DecisionRecord {
  id: string;
  time: string;
  entry: string;
  permission: string;
  outcome: (typeof DECISION_OUTCOMES)[number];
  operation?: string;
  session?: string;
  decider: Decider;
  channel: string;
  answer?: (typeof ANSWERS)[number];
}

// Records are appended to `<dir>/decisions.jsonl`, one JSON object per line, next to the `grants.json`
// that decided. The file is never rewritten. When it reaches the bound, the writer renames it to
// `decisions-<UTC timestamp>.jsonl` and starts a new one; re-write never deletes a record, retention
// is the operator's (HCS-0005 OQ-0005-6).
export const DECISIONS_FILE = 'decisions.jsonl';
/** Size at which the current log is rotated, unless `REWRITE_DECISIONS_MAX_BYTES` or `maxBytes` says otherwise. */
export const DECISION_LOG_MAX_BYTES = 16 * 1024 * 1024;
const ROTATED = /^decisions-(\d{8}T\d{6}\.\d{3}Z)(?:-(\d+))?\.jsonl$/;

const MEMBERS = ['id', 'time', 'entry', 'permission', 'outcome', 'operation', 'session', 'decider', 'channel', 'answer'];
// RFC 3339 UTC, the pattern of the HCS-0005 `decisionRecord` schema.
const TIME = /^[0-9]{4}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])T([01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9](\.[0-9]{1,9})?Z$/;

type Obj = Record<string, unknown>;
const object = (value: unknown): value is Obj => value !== null && typeof value === 'object' && !Array.isArray(value);
const identifier = (value: unknown) => typeof value === 'string' && value.length >= 1 && [...value].length <= 256;
const dotted = (value: unknown) => typeof value === 'string' && isDottedId(value);
const oneOf = (values: readonly string[], value: unknown) => typeof value === 'string' && values.includes(value);
// JavaScript's $ also matches before a final newline; refuse it.
const time = (value: unknown) => typeof value === 'string' && !value.endsWith('\n') && TIME.test(value);

/**
 * Validates a value against the HCS-0005 `decisionRecord` schema (HCS-0005-R011). Returns the
 * JSON-pointer locations of the violations; an empty array means valid. Members the schema does not
 * define are violations, so operation arguments or results cannot be carried in a record.
 */
export function validateDecisionRecord(value: unknown): string[] {
  if (!object(value)) return [''];
  const violations: string[] = [];
  const pointer = (base: string, key: string) => `${base}/${key.replace(/~/g, '~0').replace(/\//g, '~1')}`;
  for (const key of Object.keys(value)) if (!MEMBERS.includes(key) && !isExtensionName(key)) violations.push(pointer('', key));
  if (!identifier(value.id)) violations.push('/id');
  if (!time(value.time)) violations.push('/time');
  if (!dotted(value.entry)) violations.push('/entry');
  if (!dotted(value.permission)) violations.push('/permission');
  if (!oneOf(DECISION_OUTCOMES, value.outcome)) violations.push('/outcome');
  const hasOperation = Object.hasOwn(value, 'operation');
  if (hasOperation ? !identifier(value.operation) : value.outcome !== 'revoked') violations.push('/operation');
  if (Object.hasOwn(value, 'session') && !identifier(value.session)) violations.push('/session');
  if (!object(value.decider)) violations.push('/decider');
  else {
    for (const key of Object.keys(value.decider)) if (key !== 'kind' && key !== 'id') violations.push(pointer('/decider', key));
    if (!oneOf(DECIDER_KINDS, value.decider.kind)) violations.push('/decider/kind');
    if (!identifier(value.decider.id)) violations.push('/decider/id');
  }
  if (!identifier(value.channel)) violations.push('/channel');
  if (Object.hasOwn(value, 'answer') && !oneOf(ANSWERS, value.answer)) violations.push('/answer');
  return violations;
}

/**
 * Appends one decision record to `<dir>/decisions.jsonl` and returns it (HCS-0005-R010). The host
 * sets `id` and `time`. Only the members named here are copied from `fields`, so nothing else a
 * caller holds (arguments, results, content) can reach the file (R011). Throws when the record does
 * not validate or the file cannot be read, rotated, written and synced; the caller then denies the
 * operation (R012). A file of `maxBytes` or more is rotated first (see `openCurrent`).
 */
export function writeDecisionRecord(dir: string, fields: Omit<DecisionRecord, 'id' | 'time'>, options: { maxBytes?: number } = {}): DecisionRecord {
  const record: DecisionRecord = {
    id: randomUUID(),
    time: new Date().toISOString(),
    entry: fields.entry,
    permission: fields.permission,
    outcome: fields.outcome,
    ...(fields.operation !== undefined ? { operation: fields.operation } : {}),
    ...(fields.session !== undefined ? { session: fields.session } : {}),
    decider: { kind: fields.decider?.kind, id: fields.decider?.id },
    channel: fields.channel,
    ...(fields.answer !== undefined ? { answer: fields.answer } : {}),
  };
  const violations = validateDecisionRecord(record);
  if (violations.length > 0) throw new Error(`Invalid decision record: ${violations.join(', ')}`);
  const maxBytes = options.maxBytes ?? configuredMaxBytes();
  mkdirSync(dir, { recursive: true });
  const fd = openCurrent(dir, maxBytes);
  try {
    // A crash in the middle of an earlier write leaves a last line without its newline. End that
    // line first, so this record is a whole line of its own and only the torn one is lost.
    const { size } = fstatSync(fd);
    const last = Buffer.alloc(1);
    const torn = size > 0 && readSync(fd, last, 0, 1, size - 1) === 1 && last[0] !== 0x0a;
    // One write of one line in append mode: records of concurrent writers do not interleave.
    writeAll(fd, Buffer.from(`${torn ? '\n' : ''}${JSON.stringify(record)}\n`));
    fsyncSync(fd);
  } finally { closeSync(fd); }
  return record;
}

// A write can stop part way (a file size limit, a full disk). Write the rest or throw, so a record is
// never reported as written when it is not; the torn part is closed by the next writer.
function writeAll(fd: number, buffer: Buffer): void {
  for (let offset = 0; offset < buffer.length;) {
    const written = writeSync(fd, buffer, offset, buffer.length - offset);
    if (written <= 0) throw new Error('Short write to the decision log');
    offset += written;
  }
}

function configuredMaxBytes(): number {
  const value = process.env.REWRITE_DECISIONS_MAX_BYTES;
  if (value === undefined || value === '') return DECISION_LOG_MAX_BYTES;
  if (!/^[1-9][0-9]*$/.test(value)) throw new Error(`REWRITE_DECISIONS_MAX_BYTES must be a positive whole number of bytes, got ${JSON.stringify(value)}`);
  return Number(value);
}

// 2026-11-11T15:54:00.123Z -> 20261111T155400.123Z: fixed width, so names sort by time.
const stamp = (date: Date) => date.toISOString().replace(/[-:]/g, '');

/**
 * Opens `<dir>/decisions.jsonl` for appending, rotating it first when it holds `maxBytes` or more.
 * Several processes may write the same directory (the CLI and the server), so rotation takes no lock
 * and relies on two properties instead. A rotated name is reserved with an exclusive create before
 * the rename replaces that empty reservation, so a rename never overwrites another file. And every
 * writer appends through a descriptor: a record written to a file another process has just renamed
 * lands in that rotated file, which is kept. A lost race can at worst rotate a newer file early;
 * it never drops or corrupts a record.
 */
function openCurrent(dir: string, maxBytes: number): number {
  const current = join(dir, DECISIONS_FILE);
  for (let attempt = 0; ; attempt++) {
    const fd = openSync(current, 'a+', 0o600);
    try {
      const held = fstatSync(fd);
      if (held.size < maxBytes || attempt >= 8) return fd;
      let named;
      try { named = statSync(current); } catch (error: any) { if (error.code !== 'ENOENT') throw error; }
      // When another writer already rotated the file this descriptor holds, just open the new one.
      if (named?.ino === held.ino && named.dev === held.dev) rotateCurrent(dir, held);
    } catch (error) { closeSync(fd); throw error; }
    closeSync(fd);
  }
}

function rotateCurrent(dir: string, held: { ino: number; dev: number }): void {
  const current = join(dir, DECISIONS_FILE);
  const base = `decisions-${stamp(new Date())}`;
  let target = '';
  for (let n = 0; ; n++) {
    target = join(dir, `${base}${n === 0 ? '' : `-${n}`}.jsonl`);
    try { closeSync(openSync(target, 'wx', 0o600)); break; } catch (error: any) { if (error.code !== 'EEXIST') throw error; }
  }
  try { renameSync(current, target); } catch (error: any) {
    unlinkSync(target);
    // Another writer renamed it between the check and here; the caller opens the new file.
    if (error.code !== 'ENOENT') throw error;
    return;
  }
  const renamed = statSync(target);
  if (renamed.ino === held.ino && renamed.dev === held.dev) return;
  // Another writer rotated the full file first and this rename took the new one, under a name that may
  // sort before it. Give it its name back; `link` never replaces a file, so when yet another writer
  // has already started a new one, keep the early rotation (records are kept, only file order differs).
  try { linkSync(target, current); } catch (error: any) { if (error.code === 'EEXIST') return; throw error; }
  unlinkSync(target);
}

/**
 * Reads the current `<dir>/decisions.jsonl` (not the rotated files, see `readAllDecisionLogs`): the valid records, oldest first, and the 1-based numbers of the
 * lines that are not one (a line torn by a crash, or anything that does not validate). An invalid
 * line never hides the records around it, and its content is not returned. Both are empty when the
 * file does not exist.
 */
export function readDecisionLog(dir: string): { records: DecisionRecord[]; invalid: number[] } {
  return readLogFile(join(dir, DECISIONS_FILE));
}

function readLogFile(path: string): { records: DecisionRecord[]; invalid: number[] } {
  let text: string;
  try { text = readFileSync(path, 'utf8'); } catch (error: any) { if (error.code === 'ENOENT') return { records: [], invalid: [] }; throw error; }
  const records: DecisionRecord[] = [];
  const invalid: number[] = [];
  text.split('\n').forEach((line, index) => {
    if (line === '') return;
    let value: unknown;
    try { value = JSON.parse(line); } catch { invalid.push(index + 1); return; }
    if (validateDecisionRecord(value).length > 0) invalid.push(index + 1);
    else records.push(value as DecisionRecord);
  });
  return { records, invalid };
}

/**
 * The decision logs of `<dir>`, oldest first: the rotated `decisions-<UTC timestamp>.jsonl` files in
 * the order they were rotated, then `decisions.jsonl` when it exists. Empty when `dir` does not exist.
 */
export function listDecisionLogs(dir: string): string[] {
  let names: string[];
  try { names = readdirSync(dir); } catch (error: any) { if (error.code === 'ENOENT') return []; throw error; }
  const rotated = names.flatMap(name => {
    const match = ROTATED.exec(name);
    return match ? [{ name, time: match[1], n: Number(match[2] ?? 0) }] : [];
  }).sort((a, b) => a.time < b.time ? -1 : a.time > b.time ? 1 : a.n - b.n).map(({ name }) => name);
  return names.includes(DECISIONS_FILE) ? [...rotated, DECISIONS_FILE] : rotated;
}

/**
 * Reads every decision log of `<dir>` (see `listDecisionLogs`) like `readDecisionLog` reads the
 * current one: the records sorted by `time` (ties in file order, then line order), and each invalid
 * line by file name and 1-based line number.
 */
export function readAllDecisionLogs(dir: string): { records: DecisionRecord[]; invalid: Array<{ file: string; line: number }> } {
  const records: DecisionRecord[] = [];
  const invalid: Array<{ file: string; line: number }> = [];
  for (const file of listDecisionLogs(dir)) {
    const log = readLogFile(join(dir, file));
    records.push(...log.records);
    invalid.push(...log.invalid.map(line => ({ file, line })));
  }
  // Concurrent rotation can leave a later record in a file rotated under an earlier name, so file
  // names do not order records. The sort is stable: equal times keep file order, then line order.
  records.sort((a, b) => Date.parse(a.time) - Date.parse(b.time));
  return { records, invalid };
}

/** Every record of `<dir>/decisions.jsonl`, oldest first. Throws when a line is invalid: use `readDecisionLog` to read around it. */
export function readDecisionRecords(dir: string): DecisionRecord[] {
  const { records, invalid } = readDecisionLog(dir);
  if (invalid.length > 0) throw new Error(`${invalid.length} invalid line${invalid.length === 1 ? '' : 's'} in ${DECISIONS_FILE} (${invalid.join(', ')})`);
  return records;
}
