import type { IncomingMessage, RequestListener, ServerResponse } from 'node:http';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { Library } from '../application/library.ts';
import { TokenVerifier } from './auth.ts';
import { llmsText } from './llms.ts';
import { buildMcpServer } from './mcp.ts';
import { REVIEW_CSS, REVIEW_JS, reviewCsp, reviewHtml } from './review-page.ts';
import { VERDICTS, type VerdictKind } from '../domain/continuity.ts';

export interface ServerConfig {
  issuer: string;
  resource: string;
  reviewOrigin: string;
  clerkPublishableKey: string;
}

const MAX_BODY_BYTES = 1_048_576;
const MAX_NOTE = 2_000;

class HttpError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function requireHttps(name: string, value: string): void {
  if (new URL(value).protocol !== 'https:') throw new Error(`${name} must use https`);
}

/** Reads settings. There is deliberately no setting that turns authentication off. */
export function readConfig(env: Record<string, string | undefined>): { config: ServerConfig; dataDir: string; port: number } {
  const need = (name: string): string => {
    const value = env[name];
    if (!value) throw new Error(`missing setting: ${name}`);
    return value;
  };
  const issuer = need('MCP_OAUTH_ISSUER');
  const resource = need('MCP_OAUTH_RESOURCE');
  requireHttps('MCP_OAUTH_ISSUER', issuer);
  requireHttps('MCP_OAUTH_RESOURCE', resource);
  return {
    config: {
      issuer,
      resource,
      reviewOrigin: new URL(resource).origin,
      clerkPublishableKey: need('CLERK_PUBLISHABLE_KEY'),
    },
    dataDir: need('REWRITE_DATA_DIR'),
    port: Number(env.PORT ?? 8080),
  };
}

export function metadataUrlFor(resource: string): string {
  const url = new URL(resource);
  return `${url.origin}/.well-known/oauth-protected-resource${url.pathname.replace(/\/$/, '')}`;
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json');
  res.setHeader('cache-control', 'no-store');
  res.end(JSON.stringify(body));
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new HttpError(413, 'body too large');
    chunks.push(chunk as Buffer);
  }
  if (size === 0) return undefined;
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError(400, 'body is not valid JSON');
  }
}

function bearerOf(req: IncomingMessage): string | null {
  const header = req.headers.authorization;
  return header?.startsWith('Bearer ') ? header.slice('Bearer '.length).trim() : null;
}

export function createHandler(config: ServerConfig, library: Library): RequestListener {
  const verifier = new TokenVerifier(config);
  const allowedHost = new URL(config.resource).host;
  const resourcePath = new URL(config.resource).pathname;
  const metadataUrl = metadataUrlFor(config.resource);
  const metadata = {
    resource: config.resource,
    authorization_servers: [config.issuer],
    bearer_methods_supported: ['header'],
  };

  const serveMcp = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const challenge = `Bearer resource_metadata="${metadataUrl}"`;
    const raw = bearerOf(req);
    if (!raw) {
      res.setHeader('www-authenticate', challenge);
      json(res, 401, { error: 'unauthorized' });
      return;
    }
    let subject: string;
    try {
      subject = await verifier.verifyAccessToken(raw);
    } catch (error) {
      console.error(`access token rejected: ${(error as Error).message.slice(0, 120)}`);
      res.setHeader('www-authenticate', `${challenge}, error="invalid_token"`);
      json(res, 401, { error: 'unauthorized' });
      return;
    }
    // Stateless, so there is no stream to resume and no session to delete.
    if (req.method !== 'POST') {
      res.setHeader('allow', 'POST');
      json(res, 405, { error: 'method not allowed' });
      return;
    }
    const body = await readBody(req);
    // Stateless: one server per request, so nothing about a person outlives the call.
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    const server = buildMcpServer(library, subject);
    res.on('close', () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, body);
  };

  /** The people's door. Only a browser session opens it, never an agent's access token. */
  const serveReviewApi = async (req: IncomingMessage, res: ServerResponse, path: string): Promise<void> => {
    const raw = bearerOf(req);
    let subject: string;
    try {
      if (!raw) throw new Error('no token');
      subject = await verifier.verifySessionToken(raw);
    } catch (error) {
      console.error(`session token rejected: ${(error as Error).message.slice(0, 120)}`);
      return json(res, 401, { error: 'unauthorized' });
    }
    let parts: string[];
    try {
      parts = path.split('/').slice(3).map(decodeURIComponent);
    } catch {
      throw new HttpError(404, 'not found');
    }
    const [, book, kind, id] = parts;
    const open = () => {
      try {
        return library.open(book, subject);
      } catch {
        throw new HttpError(404, 'not found');
      }
    };
    if (parts[0] !== 'books') throw new HttpError(404, 'not found');
    if (req.method === 'GET' && parts.length === 1) {
      const books = library.booksFor(subject).map((b) => ({ book_id: b, title: library.open(b, subject).title() }));
      return json(res, 200, { books });
    }
    if (req.method === 'GET' && parts.length === 2) return json(res, 200, open().reviewQueue());
    if (req.method !== 'POST' || parts.length !== 4) throw new HttpError(404, 'not found');

    const project = open();
    const body = (await readBody(req) ?? {}) as { decision?: unknown; verdict?: unknown; note?: unknown };
    const note = typeof body.note === 'string' ? body.note.slice(0, MAX_NOTE) : undefined;
    const decision = () => {
      if (body.decision !== 'accept' && body.decision !== 'reject') throw new HttpError(400, 'decision must be accept or reject');
      return body.decision;
    };
    const refusable = (run: () => unknown): void => {
      try {
        json(res, 200, run());
      } catch (error) {
        if (error instanceof HttpError) throw error;
        json(res, 409, { error: library.publicMessage(error) });
      }
    };
    if (kind === 'claims') return refusable(() => project.reviewClaim(id, decision(), subject, note));
    if (kind === 'proposals') return refusable(() => project.reviewProposal(id, decision(), subject, note));
    if (kind === 'findings') {
      const verdict = body.verdict as VerdictKind;
      if (!VERDICTS.includes(verdict)) throw new HttpError(400, 'unknown verdict');
      return refusable(() => project.reviewFinding(id, verdict, subject, note));
    }
    throw new HttpError(404, 'not found');
  };

  const serveAsset = (res: ServerResponse, type: string, content: string): void => {
    res.setHeader('content-type', type);
    res.setHeader('content-security-policy', reviewCsp(config.issuer));
    res.setHeader('x-content-type-options', 'nosniff');
    res.setHeader('referrer-policy', 'no-referrer');
    res.end(content);
  };

  return (req, res) => {
    void (async () => {
      let path: string;
      try {
        path = new URL(req.url ?? '/', 'http://localhost').pathname;
      } catch {
        throw new HttpError(400, 'invalid request target');
      }
      // Container health checks arrive by address, so this comes before the host check.
      if (path === '/health' && req.method === 'GET') return json(res, 200, { status: 'ok' });
      // Defence against DNS rebinding: only the public name of this server is served.
      if (req.headers.host !== allowedHost) throw new HttpError(403, 'invalid host');
      if (req.method === 'GET' && (path === new URL(metadataUrl).pathname || path === '/.well-known/oauth-protected-resource')) {
        return json(res, 200, metadata);
      }
      if (req.method === 'GET' && path === '/') {
        res.statusCode = 302;
        res.setHeader('location', '/review');
        res.end();
        return;
      }
      if ((req.method === 'GET' || req.method === 'HEAD') && path === '/llms.txt') {
        res.setHeader('content-type', 'text/plain; charset=utf-8');
        res.end(llmsText(config.resource));
        return;
      }
      if (path === resourcePath) return await serveMcp(req, res);
      if (path.startsWith('/review/api/')) return await serveReviewApi(req, res, path);
      if (req.method === 'GET' && path === '/review') {
        return serveAsset(res, 'text/html; charset=utf-8', reviewHtml(config.issuer, config.clerkPublishableKey));
      }
      if (req.method === 'GET' && path === '/review/app.js') return serveAsset(res, 'text/javascript; charset=utf-8', REVIEW_JS);
      if (req.method === 'GET' && path === '/review/app.css') return serveAsset(res, 'text/css; charset=utf-8', REVIEW_CSS);
      throw new HttpError(404, 'not found');
    })().catch((error) => {
      const status = error instanceof HttpError ? error.status : 500;
      if (status === 500) console.error(library.publicMessage(error));
      if (res.headersSent) {
        res.destroy();
        return;
      }
      req.resume();
      res.setHeader('connection', 'close');
      json(res, status, { error: status === 500 ? 'internal error' : (error as Error).message });
    });
  };
}
