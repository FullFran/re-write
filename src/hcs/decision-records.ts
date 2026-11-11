import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, writeSync } from 'node:fs';
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
// that decided. The file is never rewritten; retention is the operator's (HCS-0005 OQ-0005-6).
export const DECISIONS_FILE = 'decisions.jsonl';

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
 * not validate or the file cannot be written and synced; the caller then denies the operation (R012).
 */
export function writeDecisionRecord(dir: string, fields: Omit<DecisionRecord, 'id' | 'time'>): DecisionRecord {
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
  mkdirSync(dir, { recursive: true });
  // One write of one line in append mode: records of concurrent writers do not interleave.
  const fd = openSync(join(dir, DECISIONS_FILE), 'a', 0o600);
  try { writeSync(fd, `${JSON.stringify(record)}\n`); fsyncSync(fd); } finally { closeSync(fd); }
  return record;
}

/** The records in `<dir>/decisions.jsonl`, oldest first; none when the file does not exist. */
export function readDecisionRecords(dir: string): DecisionRecord[] {
  let text: string;
  try { text = readFileSync(join(dir, DECISIONS_FILE), 'utf8'); } catch (error: any) { if (error.code === 'ENOENT') return []; throw error; }
  return text.split('\n').filter(line => line !== '').map(line => JSON.parse(line) as DecisionRecord);
}
