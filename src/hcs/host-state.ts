import { randomBytes } from 'node:crypto';
import { chmodSync, closeSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, unlinkSync, writeFileSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { readCatalog, type CatalogEntry } from './catalog.ts';
import { HcsFailure, hcsError, type HcsError } from './errors.ts';
import { REWRITE_HOST, type HostProfile } from './host.ts';
import { canTransition, type EntryState, type EntryStatus } from './lifecycle.ts';
import { fetchPackageBytes, sealTree, unpackPackage } from './package.ts';
import { resolve } from './resolve.ts';

// Starts and stops prepared entries. Both calls receive a signal that the host aborts when the step
// exceeds its deadline; an activator MUST stop its work when the signal aborts (HCS-0004-R007).
export interface Activator {
  activate(entry: CatalogEntry, dir: string, signal: AbortSignal): Promise<void>;
  stop(entry: CatalogEntry, signal: AbortSignal): Promise<void>;
}
export interface ApplyOptions {
  stateDir: string;
  storeDir?: string;
  host?: HostProfile;
  activator?: Activator;
  // Authorization hook; #30 replaces the default with grant decisions (HCS-0005).
  authorize?: (entry: CatalogEntry) => Promise<boolean>;
  stepDeadlineMs?: number;
}
export interface ApplyResult { generation: number; status: EntryStatus[] }
export interface GenerationRecord { catalog: { id: string; version: string }; entries: CatalogEntry[] }
export interface HostState { generation: number | null; record: GenerationRecord | null; entries: EntryStatus[] }

// Runs no package code: activating an entry only makes its provided capabilities callable.
export const NO_CODE_ACTIVATOR: Activator = { activate: async () => {}, stop: async () => {} };
export const DEFAULT_STEP_DEADLINE_MS = 30_000;

// Another writer holds the state directory (#10). A re-write refusal, not an HCS error.
export class HostBusyError extends Error {
  readonly code = 'host_busy';
  readonly holder: number | undefined;
  constructor(holder: number | undefined) {
    super(holder === undefined ? 'Host state is locked by another writer' : `Host state is locked by process ${holder}`);
    this.name = 'HostBusyError';
    this.holder = holder;
  }
}

const generationsDir = (stateDir: string) => join(stateDir, 'generations');
const generationDir = (stateDir: string, n: number) => join(generationsDir(stateDir), String(n));
export const entryDir = (stateDir: string, n: number, entry: string) => join(generationDir(stateDir, n), 'entries', entry);

function readJson(path: string): unknown {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch (error: any) { if (error.code === 'ENOENT') return undefined; throw error; }
}

// Replace a small file in one step: write a sibling temp file, fsync, rename.
function writeAtomic(dir: string, name: string, value: unknown): void {
  const temp = join(dir, `.${name}.${randomBytes(8).toString('hex')}.tmp`);
  const fd = openSync(temp, 'wx', 0o644);
  try { writeSync(fd, `${JSON.stringify(value, null, 2)}\n`); fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(temp, join(dir, name));
}

export function activeGeneration(stateDir: string): number | null {
  const pointer = readJson(join(stateDir, 'active')) as { generation?: unknown } | undefined;
  return pointer && Number.isSafeInteger(pointer.generation) ? pointer.generation as number : null;
}
export function readGeneration(stateDir: string, n: number): GenerationRecord {
  return JSON.parse(readFileSync(join(generationDir(stateDir, n), 'generation.json'), 'utf8')) as GenerationRecord;
}

interface StatusFile { generation: number | null; entries: EntryStatus[] }

// The pointed generation with the persisted state of its entries. Persistence across restarts is
// open in HCS (OQ-0004-4): without a status written for that generation its entries are `prepared`.
export function readHostState(stateDir: string): HostState {
  const generation = activeGeneration(stateDir);
  if (generation === null) return { generation, record: null, entries: [] };
  const record = readGeneration(stateDir, generation);
  const saved = readJson(join(stateDir, 'status.json')) as StatusFile | undefined;
  const known = saved?.generation === generation ? new Map(saved.entries.map(s => [s.entry, s])) : new Map<string, EntryStatus>();
  const entries = record.entries.map(e => known.get(e.id) ?? { entry: e.id, version: e.version, state: 'prepared' as EntryState });
  return { generation, record, entries };
}

// Statuses of the active generation's entries in activation order, followed by entries that failed
// in the last transition and are not part of the active generation (HCS-0004-R002).
export function statusReport(stateDir: string): EntryStatus[] {
  const saved = readJson(join(stateDir, 'status.json')) as StatusFile | undefined;
  return saved?.entries ?? [];
}

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (error: any) { return error.code === 'EPERM'; }
}

// Single writer for the host's installed state (#10). A lock whose process is gone is taken over.
function acquireLock(stateDir: string): () => void {
  mkdirSync(stateDir, { recursive: true });
  const path = join(stateDir, 'lock');
  for (let attempt = 0; attempt < 3; attempt++) {
    let fd: number;
    try { fd = openSync(path, 'wx', 0o644); } catch (error: any) {
      if (error.code !== 'EEXIST') throw error;
      let content: string;
      try { content = readFileSync(path, 'utf8'); } catch (readError: any) { if (readError.code === 'ENOENT') continue; throw readError; }
      let pid: number | undefined;
      try { const value = JSON.parse(content).pid; if (Number.isSafeInteger(value) && value > 0) pid = value; } catch { /* a lock being written */ }
      if (pid === undefined || alive(pid)) throw new HostBusyError(pid);
      // Remove the stale lock only if it is still the one that was inspected.
      try { if (readFileSync(path, 'utf8') === content) unlinkSync(path); } catch (staleError: any) { if (staleError.code !== 'ENOENT') throw staleError; }
      continue;
    }
    try { writeSync(fd, JSON.stringify({ pid: process.pid, at: new Date().toISOString() })); fsyncSync(fd); } finally { closeSync(fd); }
    return () => rmSync(path, { force: true });
  }
  throw new HostBusyError(undefined);
}

type StepResult<T> = { ok: true; value: T } | { ok: false; timeout: boolean; error: unknown };
const DEADLINE = Symbol('deadline');

// Runs one lifecycle step under the deadline. On expiry the signal is aborted and the step is
// abandoned: the host does not wait for it any longer.
async function runStep<T>(deadlineMs: number, fn: (signal: AbortSignal) => Promise<T>): Promise<StepResult<T>> {
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  const work = Promise.resolve().then(() => fn(controller.signal));
  work.catch(() => {});
  const expired = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(DEADLINE), deadlineMs); });
  expired.catch(() => {});
  try { return { ok: true, value: await Promise.race([work, expired]) }; }
  catch (error) {
    if (error === DEADLINE) { controller.abort(new Error('Lifecycle step deadline exceeded')); return { ok: false, timeout: true, error }; }
    return { ok: false, timeout: false, error };
  } finally { clearTimeout(timer); }
}

const reason = (error: unknown) => error instanceof Error && error.message ? error.message : String(error);

function stepError(step: string, entry: string, result: { timeout: boolean; error: unknown }, rollback: boolean): HcsError {
  const details = rollback ? { details: { 'x-rewrite-rollback': 'incomplete' } } : {};
  if (result.timeout) return hcsError('timeout', `Step ${step} exceeded the deadline`, { entry, requirement: 'HCS-0004-R007', ...details });
  return hcsError('plugin_failed', `Step ${step} failed: ${reason(result.error)}`, { entry, ...(rollback ? { requirement: 'HCS-0004-R003' } : {}), ...details });
}

function unsealTree(dir: string): void {
  chmodSync(dir, 0o700);
  for (const entry of readdirSync(dir, { withFileTypes: true })) if (entry.isDirectory()) unsealTree(join(dir, entry.name));
}

function nextGeneration(stateDir: string, current: number | null): number {
  let max = current ?? 0;
  for (const name of readdirSync(generationsDir(stateDir))) if (/^[1-9][0-9]*$/.test(name)) max = Math.max(max, Number(name));
  return max + 1;
}

class Statuses {
  readonly stateDir: string;
  generation: number | null;
  entries: EntryStatus[];
  extras: EntryStatus[] = [];
  constructor(stateDir: string, generation: number | null, entries: EntryStatus[]) {
    this.stateDir = stateDir; this.generation = generation; this.entries = entries;
  }
  save(): void {
    const ids = new Set(this.entries.map(s => s.entry));
    writeAtomic(this.stateDir, 'status.json', { generation: this.generation, entries: [...this.entries, ...this.extras.filter(s => !ids.has(s.entry))] });
  }
}

function move(status: EntryStatus, to: EntryState, error?: HcsError): void {
  if (!canTransition(status.state, to)) throw new Error(`Invalid lifecycle transition ${status.state} -> ${to}`);
  status.state = to;
  if (error) status.error = error; else delete status.error;
}
const fresh = (e: CatalogEntry): EntryStatus => ({ entry: e.id, version: e.version, state: 'discovered' });

// Moves the host from its active desired set to the set in `catalogBytes` as one transition
// (HCS-0004-R003): the new set is prepared as a new immutable generation, the pointer switches in
// one step, and any entry failing to reach `active` rolls every entry back.
export async function applyDesiredSet(catalogBytes: Uint8Array | string, options: ApplyOptions): Promise<ApplyResult> {
  const release = acquireLock(options.stateDir);
  try { return await transition(catalogBytes, options); } finally { release(); }
}

async function transition(catalogBytes: Uint8Array | string, options: ApplyOptions): Promise<ApplyResult> {
  const { stateDir } = options;
  const host = options.host ?? REWRITE_HOST, activator = options.activator ?? NO_CODE_ACTIVATOR;
  const authorize = options.authorize ?? (async () => true);
  const deadline = options.stepDeadlineMs ?? DEFAULT_STEP_DEADLINE_MS;
  const storeDir = options.storeDir ?? join(stateDir, 'store');
  mkdirSync(generationsDir(stateDir), { recursive: true });

  const previous = readHostState(stateDir);
  const view = new Statuses(stateDir, previous.generation, previous.entries.map(s => ({ ...s })));
  const reject = (failed: EntryStatus[], errors: HcsError[]): never => {
    view.extras = failed; view.save();
    throw new HcsFailure(errors);
  };

  const read = readCatalog(catalogBytes);
  if (!read.ok) throw new HcsFailure(read.errors);
  const catalog = read.catalog;
  const statuses = new Map(catalog.entries.map(e => [e.id, fresh(e)]));
  for (const status of statuses.values()) move(status, 'validated');

  // All-or-nothing: any resolution error leaves the previous generation active (HCS-0003-R008).
  const resolution = resolve(catalog, host);
  if (resolution.errors.length) {
    const failed: EntryStatus[] = [];
    for (const error of resolution.errors) {
      const status = error.entry === undefined ? undefined : statuses.get(error.entry);
      if (status && status.state !== 'failed') { move(status, 'failed', error); failed.push(status); }
    }
    reject(failed, resolution.errors);
  }
  const byId = new Map(catalog.entries.map(e => [e.id, e]));
  const selected = resolution.selected.map(id => byId.get(id)!);
  for (const e of selected) move(statuses.get(e.id)!, 'resolved');

  const denied: HcsError[] = [];
  for (const e of selected) {
    const result = await runStep(deadline, () => authorize(e));
    const error = !result.ok ? (result.timeout ? stepError('authorize', e.id, result, false) : hcsError('permission_denied', `Authorization failed: ${reason(result.error)}`, { entry: e.id }))
      : result.value ? undefined : hcsError('permission_denied', 'Entry is not authorized', { entry: e.id });
    move(statuses.get(e.id)!, error ? 'failed' : 'authorized', error);
    if (error) denied.push(error);
  }
  if (denied.length) reject(selected.map(e => statuses.get(e.id)!).filter(s => s.state === 'failed'), denied);

  // Prepare a NEW generation directory; content of a prepared generation is never modified (HCS-0007-R017).
  // No package code runs before this point (HCS-0004-R001).
  const n = nextGeneration(stateDir, previous.generation);
  const partial = join(generationsDir(stateDir), `.${n}.partial-${randomBytes(8).toString('hex')}`);
  mkdirSync(join(partial, 'entries'), { recursive: true });
  try {
    for (const e of selected) {
      const result = await runStep(deadline, () => fetchPackageBytes(e, { storeDir }));
      let error: HcsError | undefined;
      if (!result.ok) error = result.timeout ? stepError('prepare', e.id, result, false) : hcsError('integrity_mismatch', `Package content unavailable: ${reason(result.error)}`, { entry: e.id, requirement: 'HCS-0001-R007' });
      else {
        try { unpackPackage(result.value, e, join(partial, 'entries', e.id)); } catch (unpackError) {
          if (!(unpackError instanceof HcsFailure)) throw unpackError;
          error = { ...unpackError.errors[0], entry: e.id };
        }
      }
      if (error) { move(statuses.get(e.id)!, 'failed', error); reject([statuses.get(e.id)!], [error]); }
      move(statuses.get(e.id)!, 'prepared');
    }
    const record: GenerationRecord = { catalog: { id: catalog.id, version: catalog.version }, entries: selected };
    writeFileSync(join(partial, 'generation.json'), `${JSON.stringify(record, null, 2)}\n`, { flag: 'wx' });
    sealTree(partial);
    renameSync(partial, generationDir(stateDir, n));
  } catch (error) {
    unsealTree(partial); rmSync(partial, { recursive: true, force: true });
    throw error;
  }

  const errors: HcsError[] = [];
  const oldEntries = (previous.record?.entries ?? []).map((e, i) => ({ entry: e, status: view.entries[i] }));
  const stoppedOld: typeof oldEntries = [];

  // Stop the previous generation in reverse activation order (HCS-0004-R004).
  const stopAll = async (list: { entry: CatalogEntry; status: EntryStatus }[], rollback: boolean) => {
    for (const { entry, status } of [...list].reverse()) {
      if (status.state !== 'active') continue;
      move(status, 'draining'); view.save();
      const result = await runStep(deadline, signal => activator.stop(entry, signal));
      if (result.ok) { move(status, 'stopped'); view.save(); continue; }
      const error = stepError('stop', entry.id, result, rollback);
      move(status, 'failed', error); view.save(); errors.push(error);
      if (!rollback) return false;
    }
    return true;
  };
  for (const item of oldEntries) if (item.status.state === 'active') stoppedOld.push(item);

  const started: { entry: CatalogEntry; status: EntryStatus }[] = [];
  let ok = await stopAll(oldEntries, false);
  if (ok) {
    writeAtomic(stateDir, 'active', { generation: n });
    view.generation = n; view.entries = selected.map(e => statuses.get(e.id)!); view.save();
    for (const e of selected) {
      const status = statuses.get(e.id)!;
      const result = await runStep(deadline, signal => activator.activate(e, entryDir(stateDir, n, e.id), signal));
      if (result.ok) { move(status, 'active'); started.push({ entry: e, status }); view.save(); continue; }
      const error = stepError('activate', e.id, result, false);
      move(status, 'failed', error); view.save(); errors.push(error);
      ok = false; break;
    }
  }
  if (ok) {
    view.extras = []; view.save();
    return { generation: n, status: statusReport(stateDir) };
  }

  // Roll back (HCS-0004-R003): stop what this transition started, restore the pointer, restart the previous set.
  await stopAll(started, true);
  if (previous.generation === null) rmSync(join(stateDir, 'active'), { force: true });
  else writeAtomic(stateDir, 'active', { generation: previous.generation });
  view.generation = previous.generation; view.entries = oldEntries.map(o => o.status); view.extras = selected.map(e => statuses.get(e.id)!).filter(s => s.state === 'failed'); view.save();
  for (const { entry, status } of stoppedOld) {
    if (status.state !== 'stopped') continue;
    const result = await runStep(deadline, signal => activator.activate(entry, entryDir(stateDir, previous.generation!, entry.id), signal));
    // A restarted entry returns to the state it had before the transition began.
    if (result.ok) { status.state = 'active'; delete status.error; }
    else { const error = stepError('activate', entry.id, result, true); status.state = 'failed'; status.error = error; errors.push(error); }
    view.save();
  }
  throw new HcsFailure(errors);
}
