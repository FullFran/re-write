import { isHcsErrorCode, type HcsError } from './errors.ts';
import { isDottedId, isExtensionName, parseCapabilityRef } from './ids.ts';

export const ENTRY_STATES = ['discovered', 'validated', 'resolved', 'authorized', 'prepared', 'active', 'draining', 'stopped', 'failed'] as const;
export type EntryState = (typeof ENTRY_STATES)[number];
export const ALLOWED_TRANSITIONS: Readonly<Record<EntryState, readonly EntryState[]>> = {
  discovered: ['validated', 'failed'], validated: ['resolved', 'failed'], resolved: ['authorized', 'failed'],
  authorized: ['prepared', 'failed'], prepared: ['active', 'failed'], active: ['draining', 'failed'],
  draining: ['stopped', 'failed'], stopped: [], failed: [],
};
export function canTransition(from: string, to: string): boolean {
  return Object.hasOwn(ALLOWED_TRANSITIONS, from) && ALLOWED_TRANSITIONS[from as EntryState].includes(to as EntryState);
}
export interface EntryStatus { entry: string; version: string; state: EntryState; error?: HcsError; [key: string]: unknown }

type Obj = Record<string, unknown>;
const object = (v: unknown): v is Obj => v !== null && typeof v === 'object' && !Array.isArray(v);
const dotted = (v: unknown): boolean => typeof v === 'string' && v.length <= 128 && isDottedId(v);

// Returns JSON-pointer locations of schema violations; an empty array means valid.
export function validateEntryStatus(value: unknown): string[] {
  const violations: string[] = [];
  const invalid = (path: string) => violations.push(path);
  const pointer = (base: string, key: string) => `${base}/${key.replace(/~/g, '~0').replace(/\//g, '~1')}`;
  if (!object(value)) return [''];
  for (const key of Object.keys(value)) if (!['entry', 'version', 'state', 'error'].includes(key) && !isExtensionName(key)) invalid(pointer('', key));
  if (!dotted(value.entry)) invalid('/entry');
  if (typeof value.version !== 'string' || [...value.version].length < 1 || [...value.version].length > 128 || /\s/u.test(value.version)) invalid('/version');
  if (typeof value.state !== 'string' || !(ENTRY_STATES as readonly string[]).includes(value.state)) invalid('/state');
  if (value.state === 'failed' && !Object.hasOwn(value, 'error')) invalid('/error');
  if (value.state !== 'failed' && Object.hasOwn(value, 'error')) invalid('/error');
  if (Object.hasOwn(value, 'error')) {
    const e = value.error;
    if (!object(e)) invalid('/error');
    else {
      for (const key of Object.keys(e)) if (!['code', 'message', 'entry', 'capability', 'requirement', 'details'].includes(key)) invalid(pointer('/error', key));
      if (!isHcsErrorCode(e.code)) invalid('/error/code');
      if (typeof e.message !== 'string' || e.message.length === 0) invalid('/error/message');
      if (Object.hasOwn(e, 'entry') && !dotted(e.entry)) invalid('/error/entry');
      if (Object.hasOwn(e, 'capability') && (typeof e.capability !== 'string' || e.capability.length > 140 || !parseCapabilityRef(e.capability).ok)) invalid('/error/capability');
      if (Object.hasOwn(e, 'requirement') && (typeof e.requirement !== 'string' || !/^HCS-[0-9]{4}-R[0-9]{3}$/.test(e.requirement) || e.requirement.length !== 13)) invalid('/error/requirement');
      if (Object.hasOwn(e, 'details')) {
        if (!object(e.details)) invalid('/error/details');
        else for (const key of Object.keys(e.details)) if (!isExtensionName(key)) invalid(pointer('/error/details', key));
      }
    }
  }
  return violations;
}
