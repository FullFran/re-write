import { AsyncLocalStorage } from 'node:async_hooks';
import { createHmac, randomUUID } from 'node:crypto';
import type { RequestListener } from 'node:http';
import { isHcsErrorCode } from '../hcs/errors.ts';
import { PRODUCT_PROBLEMS } from './problems.ts';

const PROBLEM_BASE = 'https://github.com/FullFran/re-write/blob/main/docs/problems.md#';
const problemTypes = new Set(Object.keys(PRODUCT_PROBLEMS).map(kind => `${PROBLEM_BASE}${kind}`));
const methods = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'CONNECT', 'TRACE']);
const rpcMethods = new Set(['initialize', 'ping', 'tools/list', 'tools/call', 'resources/list', 'resources/read', 'resources/templates/list', 'prompts/list', 'prompts/get', 'logging/setLevel', 'completion/complete', 'sampling/createMessage', 'roots/list']);

interface Context {
  request_id: string;
  door: 'mcp' | 'review' | 'public';
  subject: string;
  reason?: 'expired' | 'audience' | 'issuer' | 'signature' | 'malformed' | 'other';
  error_name?: string;
  hash: (value: string) => string;
}
const requests = new AsyncLocalStorage<Context>();

/**
 * The id of the HTTP request being handled, or undefined outside one. The server generates it (a
 * UUID per request) and echoes it in the `x-request-id` response header; a client cannot set it.
 */
export function currentRequestId(): string | undefined {
  return requests.getStore()?.request_id;
}

export function recordSubject(subject: string): void {
  const context = requests.getStore();
  if (context) context.subject = context.hash(subject);
}

export function recordAuthenticationFailure(error: unknown): void {
  const context = requests.getStore();
  if (!context) return;
  const failure = error as { code?: unknown; claim?: unknown } | undefined;
  context.reason = failure?.code === 'ERR_JWT_EXPIRED' ? 'expired'
    : failure?.code === 'ERR_JWT_CLAIM_VALIDATION_FAILED' && failure.claim === 'aud' ? 'audience'
    : failure?.code === 'ERR_JWT_CLAIM_VALIDATION_FAILED' && failure.claim === 'iss' ? 'issuer'
    : failure?.code === 'ERR_JWS_SIGNATURE_VERIFICATION_FAILED' ? 'signature'
    : failure?.code === 'ERR_JWS_INVALID' || failure?.code === 'ERR_JWT_INVALID' ? 'malformed' : 'other';
}

export function recordUnexpectedError(error: unknown): void {
  const context = requests.getStore();
  if (context) context.error_name = error instanceof Error && /^[A-Za-z]+Error$/.test(error.name) ? error.name : 'Error';
}

function write(context: Context, event: string, start: number, fields: object): void {
  // Only callers' explicit metadata fields reach stdout; never spread transport objects.
  console.log(JSON.stringify({ event, timestamp: new Date().toISOString(), request_id: context.request_id,
    door: context.door, subject: context.subject, duration_ms: Math.round((performance.now() - start) * 100) / 100, ...fields }));
}

function problemCode(value: any): string | undefined {
  if (isHcsErrorCode(value?.hcsError?.code)) return value.hcsError.code;
  return problemTypes.has(value?.type) ? value.type : undefined;
}

function routeOf(path: string, resourcePath: string): { route: string; book?: string } {
  if (path === resourcePath) return { route: resourcePath };
  const publicRoutes = ['/', '/health', '/llms.txt', '/review', '/review/app.js', '/review/app.css',
    '/review/engine', '/review/engine/app.js', '/review/engine/app.css',
    '/.well-known/oauth-protected-resource', `/.well-known/oauth-protected-resource${resourcePath.replace(/\/$/, '')}`];
  if (publicRoutes.includes(path)) return { route: path };
  if (path === '/review/api/books') return { route: path };
  if (/^\/review\/api\/engine\/(status|login|credential|prompt|abort|settings|reset)$/.test(path)) return { route: path };
  const match = /^\/review\/api\/books\/([^/]+)(.*)$/.exec(path);
  if (!match) return { route: 'unmatched' };
  let book: string;
  try { book = decodeURIComponent(match[1]); } catch { return { route: 'unmatched' }; }
  const suffix = match[2];
  const fixed = ['', '/findings', '/export', '/findings/export', '/scenes', '/notes', '/graph', '/import', '/notion-inspect', '/notion-import', '/notion/inspect', '/notion/import', '/notion/preview'];
  if (fixed.includes(suffix)) return { route: `/review/api/books/:book${suffix}`, book };
  if (/^\/scenes\/.+/.test(suffix)) return { route: '/review/api/books/:book/scenes/:file', book };
  if (/^\/notes\/.+/.test(suffix)) return { route: '/review/api/books/:book/notes/:name', book };
  const review = /^\/(claims|proposals|findings)\/[^/]+$/.exec(suffix);
  if (review) return { route: `/review/api/books/:book/${review[1]}/:id`, book };
  const action = /^\/(claims|proposals|findings)\/[^/]+\/(reopen|revert|repropose|reanchor)$/.exec(suffix);
  if (action) return { route: `/review/api/books/:book/${action[1]}/:id/${action[2]}`, book };
  return { route: 'unmatched', book };
}

// The review page polls this route every 5 s with the ETag it holds; while nothing changes, the
// answer is a bodiless 304.
const POLL_ROUTE = '/review/api/books/:book';

/**
 * One logger per server startup. Missing salt never falls back to an unkeyed hash.
 *
 * A `304` answer to a `GET` of the review poll route writes no line of its own: such answers are
 * counted, and one `http.poll_summary` line with the count is written per `pollSummaryMs` interval
 * that had any, and when the server closes. Every other request is logged one by one.
 */
export function withRequestLog(resource: string, handler: RequestListener, salt = process.env.REWRITE_LOG_SALT,
  { pollSummaryMs = 60_000 }: { pollSummaryMs?: number } = {}): RequestListener {
  if (!salt) console.warn('REWRITE_LOG_SALT is unset; authenticated subject and book hashes are unset');
  let polls = 0;
  let since = '';
  let timer: ReturnType<typeof setTimeout> | undefined;
  const flush = () => {
    clearTimeout(timer);
    timer = undefined;
    if (polls === 0) return;
    // Counts only: no request id, subject or book, so the line says nothing about who polled what.
    console.log(JSON.stringify({ event: 'http.poll_summary', timestamp: new Date().toISOString(), since, door: 'review',
      method: 'GET', route: POLL_ROUTE, status: 304, count: polls }));
    polls = 0;
  };
  const countPoll = () => {
    if (polls++ === 0) since = new Date().toISOString();
    // unref: a pending summary never keeps the process alive; closing the server flushes it.
    if (!timer) timer = setTimeout(flush, pollSummaryMs).unref();
  };
  const watched = new WeakSet<object>();
  const hash = (value: string) => salt ? createHmac('sha256', salt).update(value).digest('hex').slice(0, 16) : 'unset';
  const resourcePath = new URL(resource).pathname;
  return (req, res) => {
    let path = '';
    try { path = new URL(req.url ?? '/', 'http://localhost').pathname; } catch { /* unmatched */ }
    const { route, book } = routeOf(path, resourcePath);
    const context: Context = { request_id: randomUUID(), door: path === resourcePath ? 'mcp' : path.startsWith('/review') ? 'review' : 'public', subject: 'anon', hash };
    const start = performance.now();
    const server = (req.socket as { server?: { once(event: 'close', listener: () => void): unknown } }).server;
    if (server && !watched.has(server)) { watched.add(server); server.once('close', flush); }
    res.setHeader('x-request-id', context.request_id);
    let error: string | undefined;
    const end = res.end;
    // Inspect only problem envelopes, never normal responses or manuscript streams.
    res.end = function (...args: any[]) {
      if (String(res.getHeader('content-type')).startsWith('application/problem+json')) {
        try { error = problemCode(JSON.parse(String(args[0]))); } catch { /* no free-text fallback */ }
      }
      return (end as any).apply(this, args);
    } as typeof res.end;
    let emitted = false;
    const complete = () => {
      if (emitted) return;
      emitted = true;
      const status = res.writableFinished ? res.statusCode : 499;
      if (status === 304 && route === POLL_ROUTE && req.method === 'GET') return countPoll();
      write(context, 'http.request', start, { method: methods.has(req.method ?? '') ? req.method : 'unknown', route, status,
        ...(book !== undefined ? { book: hash(book) } : {}), ...(status >= 400 ? { error: error ?? 'error' } : {}),
        ...(context.reason ? { reason: context.reason } : {}), ...(context.error_name ? { error_name: context.error_name } : {}) });
    };
    res.once('finish', complete);
    res.once('close', complete);
    requests.run(context, () => handler(req, res));
  };
}

/** Observe JSON-RPC envelopes at the transport boundary, including SDK-owned calls and errors. */
export function observeMcpTransport(transport: {
  onmessage?: (...args: any[]) => void;
  send: (...args: any[]) => Promise<void>;
  onclose?: () => void;
}, toolNames: ReadonlySet<string>): void {
  const context = requests.getStore();
  if (!context) return;
  const pending = new Map<unknown, { start: number; method: string; tool?: string; book?: string }>();
  const onmessage = transport.onmessage;
  transport.onmessage = (message, ...rest) => {
    if (message && typeof message.method === 'string' && message.id !== undefined) {
      const method = rpcMethods.has(message.method) ? message.method : 'unknown';
      const tool = method === 'tools/call' ? (toolNames.has(message.params?.name) ? message.params.name : 'unknown') : undefined;
      const book = method === 'tools/call' && typeof message.params?.arguments?.book === 'string' ? context.hash(message.params.arguments.book) : undefined;
      pending.set(message.id, { start: performance.now(), method, ...(tool ? { tool } : {}), ...(book ? { book } : {}) });
    }
    onmessage?.(message, ...rest);
  };
  const send = transport.send.bind(transport);
  transport.send = async (message, ...rest) => {
    const call = pending.get(message?.id);
    if (call && !message?.method) {
      pending.delete(message.id);
      let result = message.error ? problemCode(message.error.data) ?? 'error' : 'ok';
      if (message.result?.isError) result = problemCode(message.result.structuredContent) ?? 'error';
      // Batch claim proposals may succeed while refusing individual candidates.
      if (!message.result?.isError && message.result?.content) {
        for (const item of message.result.content) {
          if (item.type !== 'text') continue;
          try {
            const body = JSON.parse(item.text);
            const refusal = body.rejected?.find((r: any) => problemCode(r.problem));
            if (refusal) result = problemCode(refusal.problem)!;
          } catch { /* text is never a logging fallback */ }
        }
      }
      const { start, ...fields } = call;
      write(context, 'mcp.call', start, { ...fields, result });
    }
    await send(message, ...rest);
  };
  const onclose = transport.onclose;
  transport.onclose = () => {
    for (const { start, ...fields } of pending.values()) write(context, 'mcp.call', start, { ...fields, result: 'error' });
    pending.clear();
    onclose?.();
  };
}
