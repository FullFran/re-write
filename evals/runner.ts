import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { llmsText } from '../src/adapters/llms.ts';
import { buildMcpServer } from '../src/adapters/mcp.ts';
import { Library } from '../src/application/library.ts';

/**
 * Deterministic agent-journey evals. A journey is data: a fixture book, the steps a scripted agent
 * (and the person beside it) takes, and checks over what the harness answered and stored. No model
 * and no network are involved, so a failing check is a broken guarantee of the harness.
 */

export const ROOT = resolve(import.meta.dirname, '..');
export const JOURNEYS_DIR = join(ROOT, 'evals', 'journeys');
export const RESULTS_SCHEMA = 'rewrite.eval-results/v1';

/** The person whose connection the scripted agent uses, and who reviews outside the MCP. */
const PERSON = 'user_eval';
const RESOURCE = 'https://rewrite.invalid/mcp';
const EVIDENCE_CHARS = 160;

export type Status = 'PASS' | 'FAIL' | 'SKIP';

/** What the journeys drive. Tests pass a deliberately broken build to prove the checks can fail. */
export interface Build {
  name: string;
  server(library: Library, subject: string): McpServer;
  llms(resource: string): string;
}

export const inMemoryBuild: Build = {
  name: 'in-memory',
  server: (library, subject) => buildMcpServer(library, subject),
  llms: llmsText,
};

export interface CheckResult {
  check: string;
  status: Status;
  note: string;
  evidence: string;
}

export interface JourneyResult {
  id: string;
  title: string;
  guarantee: string;
  status: Status;
  checks: CheckResult[];
}

export interface RunResults {
  schema: typeof RESULTS_SCHEMA;
  version: string;
  commit: string;
  dirty: boolean | null;
  build: string;
  summary: { journeys: Record<'pass' | 'fail', number>; checks: Record<'pass' | 'fail', number> };
  journeys: JourneyResult[];
}

const MATCHERS = ['equals', 'not_equals', 'matches', 'none_match', 'contains', 'not_contains'] as const;
type Matcher = (typeof MATCHERS)[number];
const ACTIONS = ['read_onboarding', 'list_tools', 'call', 'person_edits_scene', 'person_reviews_claim', 'book_state'] as const;
type Action = (typeof ACTIONS)[number];

interface Check {
  name: string;
  path: string;
  matcher: Matcher;
  expected: unknown;
}

interface Step {
  id: string;
  do: Action;
  fields: Record<string, unknown>;
  checks: Check[];
}

interface Journey {
  id: string;
  title: string;
  guarantee: string;
  book: { id: string; title: string; scenes: string[] };
  steps: Step[];
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function text(value: unknown, where: string): string {
  if (typeof value !== 'string' || value === '') throw new Error(`${where} must be a non-empty string`);
  return value;
}

/** Validates a journey up front, so a typo fails the journey instead of silently checking nothing. */
export function parseJourney(raw: unknown, expectedId: string): Journey {
  if (!isObject(raw)) throw new Error('a journey must be a JSON object');
  const id = text(raw.id, 'id');
  if (id !== expectedId) throw new Error(`id "${id}" must match the file name "${expectedId}"`);
  if (!isObject(raw.book)) throw new Error('book must be an object');
  const scenes = raw.book.scenes;
  if (!Array.isArray(scenes) || scenes.length === 0) throw new Error('book.scenes must list at least one file');
  if (!Array.isArray(raw.steps) || raw.steps.length === 0) throw new Error('steps must list at least one step');
  const known = new Set<string>();
  let total = 0;
  const steps = raw.steps.map((step: unknown, index: number): Step => {
    if (!isObject(step)) throw new Error(`step ${index + 1} must be an object`);
    const { id: stepId, do: action, checks = [], ...fields } = step;
    const name = text(stepId, `step ${index + 1} id`);
    if (!/^[a-z][a-z0-9_]*$/.test(name)) throw new Error(`step id "${name}" must be lower snake case`);
    if (known.has(name)) throw new Error(`duplicate step id: ${name}`);
    known.add(name);
    if (!ACTIONS.includes(action as Action)) throw new Error(`step ${name}: unknown action "${String(action)}"`);
    if (!Array.isArray(checks)) throw new Error(`step ${name}: checks must be an array`);
    const parsed = checks.map((check: unknown): Check => {
      if (!isObject(check)) throw new Error(`step ${name}: a check must be an object`);
      const { name: checkName, path, ...rest } = check;
      const used = Object.keys(rest);
      if (used.length !== 1 || !MATCHERS.includes(used[0] as Matcher)) {
        throw new Error(`step ${name}: check "${String(checkName)}" needs exactly one of ${MATCHERS.join(', ')}`);
      }
      const target = text(path, `step ${name}: check path`);
      if (!known.has(target.split('.')[0])) throw new Error(`step ${name}: path "${target}" does not start at a step that already ran`);
      return { name: text(checkName, `step ${name}: check name`), path: target, matcher: used[0] as Matcher, expected: rest[used[0]] };
    });
    total += parsed.length;
    return { id: name, do: action as Action, fields, checks: parsed };
  });
  if (total === 0) throw new Error('a journey must check something');
  return {
    id,
    title: text(raw.title, 'title'),
    guarantee: text(raw.guarantee, 'guarantee'),
    book: { id: text(raw.book.id, 'book.id'), title: text(raw.book.title, 'book.title'), scenes: scenes.map((file) => text(file, 'book.scenes entry')) },
    steps,
  };
}

const MISSING = Symbol('missing');

/** Follows a dotted path; `*` maps over an array. Anything not found is MISSING, never undefined. */
function lookup(value: unknown, segments: string[]): unknown {
  if (segments.length === 0) return value === undefined ? MISSING : value;
  const [head, ...rest] = segments;
  if (head === '*') {
    if (!Array.isArray(value)) return MISSING;
    const items = value.map((item) => lookup(item, rest));
    return items.includes(MISSING) ? MISSING : items;
  }
  if (head === 'length' && (Array.isArray(value) || typeof value === 'string')) return lookup(value.length, rest);
  if ((isObject(value) || Array.isArray(value)) && Object.hasOwn(value, head)) return lookup((value as any)[head], rest);
  return MISSING;
}

/** Replaces every `{ "ref": "step.path" }` with the value an earlier step produced. */
function resolveRefs(value: unknown, context: Record<string, unknown>): unknown {
  if (Array.isArray(value)) return value.map((item) => resolveRefs(item, context));
  if (!isObject(value)) return value;
  const keys = Object.keys(value);
  if (keys.length === 1 && keys[0] === 'ref') {
    const found = lookup(context, text(value.ref, 'ref').split('.'));
    if (found === MISSING) throw new Error(`nothing at ref ${String(value.ref)}`);
    return found;
  }
  return Object.fromEntries(keys.map((key) => [key, resolveRefs(value[key], context)]));
}

function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function show(value: unknown): string {
  const json = JSON.stringify(value) ?? String(value);
  return json.length > EVIDENCE_CHARS ? `${json.slice(0, EVIDENCE_CHARS)}...` : json;
}

/** Returns an empty string when the check holds, or why it does not. */
function mismatch(matcher: Matcher, actual: unknown, expected: unknown): string {
  switch (matcher) {
    case 'equals':
      return same(actual, expected) ? '' : `expected ${show(expected)}`;
    case 'not_equals':
      return same(actual, expected) ? `expected anything but ${show(expected)}` : '';
    case 'matches':
      if (typeof actual !== 'string') return 'matches needs a string';
      return new RegExp(String(expected)).test(actual) ? '' : `expected a match for /${String(expected)}/`;
    case 'none_match': {
      if (!Array.isArray(actual) || actual.some((item) => typeof item !== 'string')) return 'none_match needs an array of strings';
      const hits = actual.filter((item) => new RegExp(String(expected)).test(item));
      return hits.length ? `${show(hits)} match /${String(expected)}/` : '';
    }
    case 'contains':
    case 'not_contains': {
      let has: boolean;
      if (typeof actual === 'string') has = actual.includes(String(expected));
      else if (Array.isArray(actual)) has = actual.some((item) => same(item, expected));
      else return `${matcher} needs a string or an array`;
      if (matcher === 'contains') return has ? '' : `expected it to contain ${show(expected)}`;
      return has ? `expected it not to contain ${show(expected)}` : '';
    }
  }
}

function backticked(source: string): string[] {
  return [...source.matchAll(/`([a-z]+(?:_[a-z]+)+)`/g)].map((match) => match[1]);
}

/** What the public onboarding text tells an assistant to do, in the terms a journey can check. */
function readOnboarding(build: Build): unknown {
  const guide = build.llms(RESOURCE);
  const toolsLine = guide.split('\n').find((line) => line.startsWith('Tools for the agent:')) ?? '';
  const firstSteps = guide.split('## Step 3: Check it works')[1]?.split('\n## ')[0] ?? '';
  return { text: guide, advertised_tools: backticked(toolsLine).sort(), first_calls: backticked(firstSteps) };
}

async function callTool(client: Client, tool: string, args: Record<string, unknown>): Promise<unknown> {
  try {
    const result: any = await client.callTool({ name: tool, arguments: args });
    const body: string = result.content?.find((item: any) => item.type === 'text')?.text ?? '';
    let data: unknown = null;
    try {
      data = JSON.parse(body);
    } catch {
      // Refusals are plain sentences.
    }
    return { is_error: Boolean(result.isError), data, text: body, problem: result.structuredContent ?? null, rpc_error: null };
  } catch (error: any) {
    return { is_error: true, data: null, text: '', problem: null, rpc_error: { code: error?.code ?? null, message: String(error?.message ?? error) } };
  }
}

interface World {
  build: Build;
  library: Library;
  book: string;
  client: Client;
}

async function perform(step: Step, world: World, context: Record<string, unknown>): Promise<unknown> {
  const fields = resolveRefs(step.fields, context) as Record<string, any>;
  const project = () => world.library.open(world.book, PERSON);
  switch (step.do) {
    case 'read_onboarding':
      return readOnboarding(world.build);
    case 'list_tools':
      return { names: (await world.client.listTools()).tools.map((tool) => tool.name).sort() };
    case 'call':
      return callTool(world.client, text(fields.tool, 'tool'), isObject(fields.args) ? fields.args : {});
    case 'person_edits_scene': {
      // The person edits the manuscript in their own editor: the harness only sees the new text.
      const file = project().scenePath(text(fields.file, 'file'));
      const before = project().readScene(file);
      if (before === null) throw new Error(`scene not found: ${file}`);
      const find = text(fields.find, 'find');
      if (before.split(find).length !== 2) throw new Error(`"${find}" must appear exactly once in ${file}`);
      writeFileSync(join(project().dir, file), before.replace(find, String(fields.replace ?? '')));
      return { file };
    }
    case 'person_reviews_claim': {
      // Review happens outside the MCP connection, as it does in /review.
      const { claim, changed } = project().reviewClaim(text(fields.claim_id, 'claim_id'), fields.decision === 'reject' ? 'reject' : 'accept', PERSON);
      return { changed, editorial_status: claim.editorial_status };
    }
    case 'book_state': {
      const book = project();
      return {
        commits: Number(book.git.run('rev-list', '--count', 'HEAD').trim()),
        claims: book.claimViews().map((claim) => ({
          claim_id: claim.claim_id,
          statement: claim.statement,
          epistemic_kind: claim.epistemic_kind,
          editorial_status: claim.editorial_status,
          evidence_status: claim.evidence_status,
          evidence_reason: claim.evidence_reason,
        })),
        canon: book.canon().map((claim) => claim.claim_id),
        findings: book.findings.all().length,
        proposals: book.proposals.all().length,
        scenes: Object.fromEntries(book.scenes().map((file) => [file, book.readScene(file)])),
      };
    }
  }
}

function failed(check: string, note: string): CheckResult {
  return { check, status: 'FAIL', note, evidence: '' };
}

const GIT_ENV = { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };

/** Runs one journey in a fresh home and book. Anything that stops it from running is a FAIL. */
async function runJourney(journey: Journey, build: Build): Promise<CheckResult[]> {
  const scratch = mkdtempSync(join(tmpdir(), 'rewrite-eval-'));
  const saved = Object.fromEntries(['HOME', ...Object.keys(GIT_ENV)].map((key) => [key, process.env[key]]));
  Object.assign(process.env, GIT_ENV, { HOME: join(scratch, 'home') });
  const results: CheckResult[] = [];
  const clean = (message: string) => message.replaceAll(scratch, '<tmp>');
  let world: World | null = null;
  let stopped = '';
  try {
    const context: Record<string, unknown> = {};
    for (const step of journey.steps) {
      if (!stopped) {
        try {
          if (!world) {
            const library = new Library(join(scratch, 'data'));
            library.createBook(journey.book.id, journey.book.title, PERSON);
            library.open(journey.book.id, PERSON).importScenes(journey.book.scenes.map((file) => join(ROOT, file)));
            const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
            await build.server(library, PERSON).connect(serverSide);
            const client = new Client({ name: 'rewrite-eval', version: '1' });
            await client.connect(clientSide);
            world = { build, library, book: journey.book.id, client };
          }
          context[step.id] = await perform(step, world, context);
        } catch (error) {
          stopped = step.id;
          results.push(failed(`step ${step.id} runs`, clean((error as Error).message)));
        }
      }
      for (const check of step.checks) {
        if (stopped) {
          results.push(failed(check.name, `not run: step ${stopped} failed`));
          continue;
        }
        try {
          const actual = lookup(context, check.path.split('.'));
          if (actual === MISSING) {
            results.push(failed(check.name, `nothing at ${check.path}`));
            continue;
          }
          const note = mismatch(check.matcher, actual, resolveRefs(check.expected, context));
          results.push({ check: check.name, status: note ? 'FAIL' : 'PASS', note, evidence: clean(show(actual)) });
        } catch (error) {
          results.push(failed(check.name, clean((error as Error).message)));
        }
      }
    }
  } finally {
    await world?.client.close().catch(() => {});
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(scratch, { recursive: true, force: true });
  }
  return results;
}

function repository(): { commit: string; dirty: boolean | null } {
  const git = (...args: string[]) => spawnSync('git', ['-C', ROOT, ...args], { encoding: 'utf8' });
  const head = git('rev-parse', 'HEAD');
  if (head.status !== 0) return { commit: 'unknown', dirty: null };
  const status = git('status', '--porcelain');
  return { commit: head.stdout.trim(), dirty: status.status === 0 ? status.stdout.trim() !== '' : null };
}

/** Runs every journey of a directory, in file-name order, against one build. */
export async function runJourneys(options: { dir?: string; build?: Build } = {}): Promise<RunResults> {
  const dir = options.dir ?? JOURNEYS_DIR;
  const build = options.build ?? inMemoryBuild;
  const files = readdirSync(dir).filter((name) => name.endsWith('.json')).sort();
  if (files.length === 0) throw new Error(`no journeys in ${dir}`);
  const journeys: JourneyResult[] = [];
  for (const file of files) {
    const id = file.slice(0, -'.json'.length);
    let journey: Journey;
    try {
      journey = parseJourney(JSON.parse(readFileSync(join(dir, file), 'utf8')), id);
    } catch (error) {
      journeys.push({ id, title: id, guarantee: '', status: 'FAIL', checks: [failed('journey loads', (error as Error).message)] });
      continue;
    }
    const checks = await runJourney(journey, build);
    journeys.push({
      id,
      title: journey.title,
      guarantee: journey.guarantee,
      status: checks.every((check) => check.status === 'PASS') ? 'PASS' : 'FAIL',
      checks,
    });
  }
  const count = (items: { status: Status }[]) => ({
    pass: items.filter((item) => item.status === 'PASS').length,
    fail: items.filter((item) => item.status === 'FAIL').length,
  });
  const { version } = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  return {
    schema: RESULTS_SCHEMA,
    version,
    ...repository(),
    build: build.name,
    summary: { journeys: count(journeys), checks: count(journeys.flatMap((journey) => journey.checks)) },
    journeys,
  };
}

export interface Row {
  journey: string;
  check: string;
  status: string;
  note: string;
}

export function formatTable(rows: Row[]): string {
  const columns = ['journey', 'check', 'status', 'note'] as const;
  const cell = (value: string) => value.replaceAll('|', '\\|').replaceAll('\n', ' ');
  const width = (column: (typeof columns)[number]) => Math.max(column.length, ...rows.map((row) => cell(row[column]).length));
  const line = (values: string[]) => `| ${values.map((value, index) => value.padEnd(width(columns[index]))).join(' | ')} |`.trimEnd();
  return [
    line([...columns]),
    line(columns.map((column) => '-'.repeat(width(column)))),
    ...rows.map((row) => line(columns.map((column) => cell(row[column])))),
  ].join('\n');
}

export function resultRows(results: RunResults): Row[] {
  return results.journeys.flatMap((journey) => journey.checks.map((check) => ({
    journey: journey.id, check: check.check, status: check.status, note: check.note,
  })));
}

export function parseResults(raw: unknown, label: string): RunResults {
  if (!isObject(raw) || raw.schema !== RESULTS_SCHEMA || !Array.isArray(raw.journeys)) {
    throw new Error(`${label} is not a ${RESULTS_SCHEMA} file`);
  }
  return raw as unknown as RunResults;
}

export interface Comparison {
  rows: Row[];
  regressed: number;
  fixed: number;
  unchanged: number;
  skipped: number;
}

/**
 * Compares two runs check by check. Only journeys present in both are compared: the rest are
 * listed as SKIP, because a journey that exists on one side only says nothing about a change.
 */
export function compareRuns(before: RunResults, after: RunResults): Comparison {
  const comparison: Comparison = { rows: [], regressed: 0, fixed: 0, unchanged: 0, skipped: 0 };
  const skip = (journey: string, check: string, note: string) => {
    comparison.rows.push({ journey, check, status: 'SKIP', note });
    comparison.skipped += 1;
  };
  const earlier = new Map(before.journeys.map((journey) => [journey.id, journey]));
  const later = new Map(after.journeys.map((journey) => [journey.id, journey]));
  for (const id of [...new Set([...earlier.keys(), ...later.keys()])].sort()) {
    const was = earlier.get(id);
    const now = later.get(id);
    if (!was || !now) {
      skip(id, '-', was ? 'only in before' : 'only in after');
      continue;
    }
    const old = new Map(was.checks.map((check) => [check.check, check]));
    for (const check of now.checks) {
      const previous = old.get(check.check);
      old.delete(check.check);
      if (!previous) {
        skip(id, check.check, `only in after (${check.status})`);
      } else if (previous.status === check.status) {
        comparison.rows.push({ journey: id, check: check.check, status: check.status, note: 'unchanged' });
        comparison.unchanged += 1;
      } else {
        const regressed = check.status === 'FAIL';
        comparison.rows.push({
          journey: id,
          check: check.check,
          status: check.status,
          note: `${regressed ? 'regressed' : 'fixed'} (was ${previous.status})${check.note ? `: ${check.note}` : ''}`,
        });
        comparison[regressed ? 'regressed' : 'fixed'] += 1;
      }
    }
    for (const check of old.values()) skip(id, check.check, `only in before (${check.status})`);
  }
  return comparison;
}
