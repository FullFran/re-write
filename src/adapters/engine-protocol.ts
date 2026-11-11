/**
 * The line-delimited JSON protocol between the server and one engine process.
 *
 * The engine process is a separate program (see `engine/`). The server writes one JSON
 * object per line to its stdin and reads one per line from its stdout. Everything the
 * child sends is untrusted: it is parsed against the shapes below, unknown fields are
 * dropped and free text from a model provider never has a field to travel in.
 */

/** The only error texts that may reach a browser or a log. */
export const ENGINE_ERROR_CODES = [
  'model_busy', 'reconnect', 'provider_error', 'busy', 'turn_in_progress',
  'not_connected', 'engine_unavailable', 'login_failed', 'rate_limited', 'turn_limit',
] as const;
export type EngineErrorCode = typeof ENGINE_ERROR_CODES[number];

export function toErrorCode(value: unknown, fallback: EngineErrorCode = 'provider_error'): EngineErrorCode {
  return (ENGINE_ERROR_CODES as readonly unknown[]).includes(value) ? value as EngineErrorCode : fallback;
}

/** Where a writer types the device code. Fixed here, never taken from the child. */
export const DEVICE_VERIFICATION_URI = 'https://auth.openai.com/codex/device';
/** Name the engine registers RE;write's MCP server under; tools are `mcp__rewrite__<tool>`. */
export const MCP_SERVER_NAME = 'rewrite';
export const MCP_TOOL_PREFIX = `mcp__${MCP_SERVER_NAME}__`;

export const MAX_LINE_BYTES = 1_048_576;
const MAX_DELTA_CHARS = 65_536;
const MAX_SECRET_CHARS = 16_384;

/** A writer's ChatGPT credential. The refresh token is single-use and rotates. */
export interface StoredCredential {
  access: string;
  refresh: string;
  expires: number;
  accountId: string;
}

const isSecret = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= MAX_SECRET_CHARS;

export function parseCredential(value: unknown): StoredCredential | null {
  const c = value as Partial<StoredCredential> | null;
  if (typeof c !== 'object' || c === null) return null;
  if (!isSecret(c.access) || !isSecret(c.refresh) || !isSecret(c.accountId)) return null;
  if (typeof c.expires !== 'number' || !Number.isFinite(c.expires) || c.expires <= 0) return null;
  return { access: c.access, refresh: c.refresh, expires: c.expires, accountId: c.accountId };
}

export type ParentMessage =
  | { type: 'start'; mcpUrl: string; mcpToken: string; systemPrompt: string }
  | { type: 'login.start' }
  | { type: 'login.cancel' }
  | { type: 'refresh'; id: string; credential: StoredCredential }
  | { type: 'token'; id: string; access?: string; accountId?: string; expires?: number; error?: EngineErrorCode }
  | { type: 'prompt'; text: string }
  | { type: 'abort' }
  | { type: 'shutdown' };

/**
 * One step of a tool call, for the page to show what the assistant is doing. Besides the
 * tool name it carries only a call number (to pair start and end), a scene path and a
 * count: never an argument or a result as text.
 */
export interface ToolMessage {
  type: 'tool';
  name: string;
  /** An older engine program sends only the end of a call, without a phase. */
  phase: 'start' | 'end';
  ok: boolean;
  call?: number;
  scene?: string;
  count?: number;
}

/**
 * A scene path as the MCP tools name it (`scenes/003-el-faro.md`), short enough to label
 * a step. Stricter than the import rule: no control characters and at most 120 characters.
 */
export const ACTIVITY_SCENE = /^scenes\/(?![.])[^/\u0000-\u001f\u007f\u2028\u2029]{1,110}\.md$/u;
export const MAX_ACTIVITY_COUNT = 999;
const MAX_CALL = 100_000;

/** Which array of a structured result counts what a tool listed or created. */
const COUNTED: Record<string, string> = {
  list_books: 'books', list_scenes: 'scenes', list_claims: 'claims', list_proposals: 'proposals',
  list_findings: 'findings', inspect_continuity: 'findings', propose_claims: 'created', propose_findings: 'created',
};

const activityScene = (value: unknown): string | undefined => typeof value === 'string' && ACTIVITY_SCENE.test(value) ? value : undefined;
const activityCount = (value: unknown): number | undefined => Number.isInteger(value) && (value as number) >= 0 ? Math.min(value as number, MAX_ACTIVITY_COUNT) : undefined;

/**
 * What the engine program may report about a tool call, from its arguments and its result
 * as Pi hands them over (the MCP result sits in `result.structuredContent`). Only a valid
 * scene path and a count leave; text is never parsed.
 */
export function toolActivity(name: string, args: unknown, result?: unknown): { scene?: string; count?: number } {
  const out: { scene?: string; count?: number } = {};
  const scene = activityScene((args as { file?: unknown } | null)?.file);
  if (scene) out.scene = scene;
  const call = (result as { structuredContent?: { structuredContent?: unknown } } | null)?.structuredContent;
  const data = (call as { structuredContent?: unknown } | undefined)?.structuredContent as Record<string, unknown> | undefined;
  if (typeof data !== 'object' || data === null) return out;
  const tool = name.replace(MCP_TOOL_PREFIX, '');
  if (tool === 'propose_revision') {
    if (typeof data.created === 'boolean') out.count = data.created ? 1 : 0;
    return out;
  }
  const list = COUNTED[tool] ? data[COUNTED[tool]] : undefined;
  if (Array.isArray(list)) out.count = Math.min(list.length, MAX_ACTIVITY_COUNT);
  return out;
}

export type ChildMessage =
  | { type: 'ready'; piVersion: string }
  | { type: 'login.code'; userCode: string }
  | { type: 'login.done'; credential: StoredCredential }
  | { type: 'login.failed' }
  | { type: 'refresh.done'; id: string; credential: StoredCredential }
  | { type: 'refresh.failed'; id: string }
  | { type: 'token.get'; id: string }
  | { type: 'session'; tools: string[] }
  | { type: 'delta'; text: string }
  | ToolMessage
  | { type: 'done'; aborted: boolean }
  | { type: 'error'; code: EngineErrorCode };

export function encode(message: ParentMessage | ChildMessage): string {
  return `${JSON.stringify(message)}\n`;
}

const ID = /^[A-Za-z0-9-]{1,64}$/;
const USER_CODE = /^[A-Z0-9][A-Z0-9-]{2,18}[A-Z0-9]$/;
const VERSION = /^[0-9A-Za-z.+-]{1,32}$/;
const TOOL_NAME = /^[A-Za-z0-9_]{1,128}$/;

/** Accepts only known messages with well-formed fields; anything else is `null`. */
export function parseChildMessage(value: unknown): ChildMessage | null {
  const m = value as Record<string, unknown> | null;
  if (typeof m !== 'object' || m === null || Array.isArray(m)) return null;
  const id = typeof m.id === 'string' && ID.test(m.id) ? m.id : null;
  switch (m.type) {
    case 'ready':
      return { type: 'ready', piVersion: typeof m.piVersion === 'string' && VERSION.test(m.piVersion) ? m.piVersion : 'unknown' };
    case 'login.code':
      return typeof m.userCode === 'string' && USER_CODE.test(m.userCode) ? { type: 'login.code', userCode: m.userCode } : null;
    case 'login.done': {
      const credential = parseCredential(m.credential);
      return credential ? { type: 'login.done', credential } : null;
    }
    case 'login.failed':
      return { type: 'login.failed' };
    case 'refresh.done': {
      const credential = parseCredential(m.credential);
      return id && credential ? { type: 'refresh.done', id, credential } : null;
    }
    case 'refresh.failed':
      return id ? { type: 'refresh.failed', id } : null;
    case 'token.get':
      return id ? { type: 'token.get', id } : null;
    case 'session':
      return Array.isArray(m.tools) && m.tools.length <= 256 && m.tools.every((t) => typeof t === 'string' && TOOL_NAME.test(t))
        ? { type: 'session', tools: m.tools as string[] } : null;
    case 'delta':
      return typeof m.text === 'string' && m.text.length <= MAX_DELTA_CHARS ? { type: 'delta', text: m.text } : null;
    case 'tool': {
      if (typeof m.name !== 'string' || !TOOL_NAME.test(m.name)) return null;
      const phase = m.phase === 'start' ? 'start' : 'end';
      const tool: ToolMessage = { type: 'tool', phase, ...(Number.isInteger(m.call) && (m.call as number) > 0 && (m.call as number) <= MAX_CALL ? { call: m.call as number } : {}), name: m.name, ok: phase === 'start' || m.ok === true };
      const scene = activityScene(m.scene);
      if (scene) tool.scene = scene;
      const count = phase === 'end' ? activityCount(m.count) : undefined;
      if (count !== undefined) tool.count = count;
      return tool;
    }
    case 'done':
      return { type: 'done', aborted: m.aborted === true };
    case 'error':
      return { type: 'error', code: toErrorCode(m.code) };
    default:
      return null;
  }
}

/** Splits a byte stream into JSON lines. A line over the limit is a protocol violation. */
export class LineDecoder {
  private buffer = '';

  /** Returns the parsed lines; a line that is not JSON yields `undefined` in its place. */
  push(chunk: Buffer | string): unknown[] {
    this.buffer += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    const out: unknown[] = [];
    let index: number;
    while ((index = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, index);
      this.buffer = this.buffer.slice(index + 1);
      if (!line.trim()) continue;
      try { out.push(JSON.parse(line)); } catch { out.push(undefined); }
    }
    if (this.buffer.length > MAX_LINE_BYTES) {
      this.buffer = '';
      throw new Error('engine protocol line too long');
    }
    return out;
  }
}
