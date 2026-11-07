import type { IncomingMessage, RequestListener, ServerResponse } from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { Library } from '../application/library.ts';
import { slugify, BOOK_ID } from '../application/library.ts';
import { decide, enforce, ForbiddenError } from '../application/decision.ts';
import { TokenVerifier } from './auth.ts';
import { llmsText } from './llms.ts';
import { buildMcpServer } from './mcp.ts';
import { REVIEW_CSS, REVIEW_JS, reviewCsp, reviewHtml } from './review-page.ts';
import { InvalidFindingVerdictError, VERDICTS, type VerdictKind } from '../domain/continuity.ts';
import { HcsFailure } from '../hcs/errors.ts';
import { BOOK_CREATE, REVIEW_DECIDE } from '../hcs/ids.ts';
import { toProblemDetails } from '../hcs/transport.ts';
import { productProblem } from './problems.ts';
import { inspectNotion, loadNotionChapters, parseNotionMapping, type NotionMapping } from '../application/notion-export.ts';
import { chapterFilename, convertToMarkdown, importBook } from '../application/book-import.ts';

export interface ServerConfig {
  issuer: string;
  resource: string;
  reviewOrigin: string;
  clerkPublishableKey: string;
}

const MAX_BODY_BYTES = 1_048_576;
const MAX_IMPORT_BODY_BYTES = 10 * 1024 * 1024;
const MAX_NOTION_UPLOAD_BYTES = 50 * 1024 * 1024;
const MAX_SCENE_FILE_BYTES = 2 * 1024 * 1024;
const MAX_NOTE = 2_000;
const READ = 'com.fullfran.rewrite.book.read';
const IMPORT = 'com.fullfran.rewrite.book.import';
const SCENE_FILE_NAME = /^[^./][^/]*\.md$/;

function isFsError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && ('code' in error || 'syscall' in error || 'errno' in error);
}

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

function problem(res: ServerResponse, status: number, detail: string): void {
  res.statusCode = status;
  res.setHeader('content-type', 'application/problem+json');
  res.setHeader('cache-control', 'no-store');
  res.end(JSON.stringify({ ...productProblem(detail, status), error: detail }));
}

function hcsProblem(res: ServerResponse, failure: HcsFailure): void {
  const body = toProblemDetails(failure.errors[0]);
  res.statusCode = body.status;
  res.setHeader('content-type', 'application/problem+json');
  res.setHeader('cache-control', 'no-store');
  res.end(JSON.stringify({ ...body, ...(failure.errors.length > 1 ? { 'x-rewrite-errors': failure.errors } : {}) }));
}

async function readBody(req: IncomingMessage, maxBytes = MAX_BODY_BYTES): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > maxBytes) throw new HttpError(413, 'body too large');
    chunks.push(chunk as Buffer);
  }
  if (size === 0) return undefined;
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError(400, 'body is not valid JSON');
  }
}

async function readRawBody(req: IncomingMessage, maxBytes = MAX_NOTION_UPLOAD_BYTES): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > maxBytes) throw new HttpError(413, 'body too large');
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

async function parseZipUpload(req: IncomingMessage, maxBytes = MAX_NOTION_UPLOAD_BYTES): Promise<{
  zip: Buffer;
  mapping?: NotionMapping;
  dryRun: boolean;
}> {
  const rawBody = await readRawBody(req, maxBytes);
  if (rawBody.length === 0) {
    throw new HttpError(400, 'empty request body');
  }

  const contentType = req.headers['content-type'] ?? '';
  let zipBuf: Buffer = rawBody;
  let mapping: NotionMapping | undefined;
  let dryRun = false;

  // Check headers
  if (req.headers['x-dry-run'] === 'true' || req.headers['x-dry-run'] === '1') {
    dryRun = true;
  }
  const headerMapping = req.headers['x-notion-mapping'];
  if (typeof headerMapping === 'string') {
    try {
      mapping = parseNotionMapping(JSON.parse(decodeURIComponent(headerMapping)));
    } catch (error) {
      throw new HttpError(400, error instanceof SyntaxError || error instanceof URIError
        ? 'invalid x-notion-mapping header' : (error as Error).message);
    }
  }

  if (contentType.includes('multipart/form-data')) {
    try {
      const res = new Response(rawBody, { headers: { 'content-type': contentType } });
      const formData = await res.formData();
      let foundZip: Buffer | undefined;
      for (const [, val] of formData.entries()) {
        if (val instanceof Blob) {
          foundZip = Buffer.from(await val.arrayBuffer());
          break;
        }
      }
      if (foundZip) zipBuf = foundZip;
    } catch (e) {
      if (e instanceof HttpError) throw e;
      throw new HttpError(400, 'malformed multipart form data');
    }
  } else if (contentType.includes('application/json')) {
    try {
      const json = JSON.parse(rawBody.toString('utf8'));
      if (json.zip) {
        zipBuf = Buffer.from(json.zip, 'base64');
      }
    } catch (e) {
      if (e instanceof HttpError) throw e;
      throw new HttpError(400, 'malformed JSON body');
    }
  }

  return { zip: zipBuf, mapping, dryRun };
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
      problem(res, 401, 'unauthorized');
      return;
    }
    let subject: string;
    try {
      subject = await verifier.verifyAccessToken(raw);
    } catch (error) {
      console.error(`access token rejected: ${(error as Error).message.slice(0, 120)}`);
      res.setHeader('www-authenticate', `${challenge}, error="invalid_token"`);
      problem(res, 401, 'unauthorized');
      return;
    }
    // Stateless, so there is no stream to resume and no session to delete.
    if (req.method !== 'POST') {
      res.setHeader('allow', 'POST');
      problem(res, 405, 'method not allowed');
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
      return problem(res, 401, 'unauthorized');
    }
    let parts: string[];
    try {
      parts = path.split('/').slice(3).map(decodeURIComponent);
    } catch {
      throw new HttpError(404, 'not found');
    }
    const [, book, kind, id] = parts;
    // Every route that touches a book asks the single decision point first, at each request.
    const open = (permission: string) => {
      try {
        enforce({ library, subject, book, door: 'review', permission, entry: null });
        return library.open(book, subject);
      } catch (error) {
        if (error instanceof HcsFailure) throw error;
        if (error instanceof ForbiddenError) throw new HttpError(403, 'forbidden');
        throw new HttpError(404, 'not found');
      }
    };
    if (parts[0] !== 'books') throw new HttpError(404, 'not found');
    if (parts.length === 1) {
      if (req.method === 'GET') {
        const books = library.booksFor(subject)
          .filter((b) => decide({ library, subject, book: b, door: 'review', permission: READ, entry: null }).allow)
          .map((b) => ({ book_id: b, title: library.open(b, subject).title() }));
        return json(res, 200, { books });
      }
      if (req.method === 'POST') {
        enforce({ library, subject, book: null, door: 'review', permission: BOOK_CREATE, entry: null });
        const body = (await readBody(req) ?? {}) as { title?: unknown; slug?: unknown };
        if (typeof body.title !== 'string' || !body.title.trim()) {
          throw new HttpError(400, 'missing title');
        }
        const title = body.title.trim();
        const slug = (typeof body.slug === 'string' && body.slug.trim()) ? body.slug.trim() : slugify(title);
        if (!BOOK_ID.test(slug)) {
          throw new HttpError(400, `invalid book slug: ${slug}`);
        }
        try {
          const created = library.createBook(slug, title, subject);
          return json(res, 201, created);
        } catch (error) {
          const msg = library.publicMessage(error);
          if (msg.includes('already exists')) {
            return problem(res, 409, msg);
          }
          throw error;
        }
      }
      throw new HttpError(404, 'not found');
    }

    if (parts.length === 2 && req.method === 'GET') {
      const project = open(READ);
      return json(res, 200, { ...project.reviewQueue(), scenes: project.scenes() });
    }

    if (parts.length === 3 && parts[2] === 'findings' && req.method === 'GET') {
      const project = open(READ);
      return json(res, 200, { findings: project.findingViews() });
    }

    if (
      ((parts.length === 3 && parts[2] === 'export') ||
       (parts.length === 4 && parts[2] === 'findings' && parts[3] === 'export')) &&
      req.method === 'GET'
    ) {
      const project = open(READ);
      const findings = project.findingViews();
      const exportData = {
        book,
        exported_at: new Date().toISOString(),
        findings: findings.map((f) => ({
          finding_id: f.finding_id,
          question: f.question,
          kind: f.kind,
          statement: f.statement,
          characters: f.characters,
          author: f.author,
          created_at: f.created_at,
          evidence_status: f.evidence_status,
          evidence: f.evidence.map((e) => ({
            file: e.file,
            quote: e.quote,
            status: e.status,
            reason: e.reason,
          })),
          verdict: f.verdict,
          rating: f.verdict ? {
            verdict: f.verdict.verdict,
            by: f.verdict.by,
            at: f.verdict.at,
            note: f.verdict.note,
            history: (f.verdict as any).history,
          } : undefined,
        })),
      };
      res.setHeader('content-disposition', `attachment; filename="findings-${book}.json"`);
      return json(res, 200, exportData);
    }

    if (parts.length === 3 && parts[2] === 'scenes' && req.method === 'GET') {
      return json(res, 200, { scenes: open(READ).scenes() });
    }

    if (parts.length >= 4 && parts[2] === 'scenes' && req.method === 'GET') {
      const rawScene = parts.slice(3).join('/');
      const sceneFile = rawScene.startsWith('scenes/') ? rawScene : `scenes/${rawScene}`;
      const project = open(READ);
      let text: string | null = null;
      try {
        text = project.readScene(sceneFile);
      } catch {
        throw new HttpError(404, 'not found');
      }
      if (text === null) throw new HttpError(404, 'not found');
      const proposals = project.proposals.all()
        .filter((p) => p.file === sceneFile && p.status === 'proposed')
        .map((p) => project.showProposal(p.proposal_id));
      const findings = project.findingViews()
        .filter((f) => f.evidence.some((e) => e.file === sceneFile));
      return json(res, 200, { file: sceneFile, text, proposals, findings });
    }

    if (parts.length === 3 && parts[2] === 'import' && req.method === 'POST') {
      const project = open(IMPORT);
      const body = (await readBody(req, MAX_IMPORT_BODY_BYTES) ?? {}) as { files?: unknown };
      if (!body.files || !Array.isArray(body.files) || body.files.length === 0) {
        throw new HttpError(400, 'files must be a non-empty array');
      }
      const seenNames = new Set<string>();
      for (const file of body.files as Array<{ name?: unknown; content?: unknown }>) {
        if (typeof file?.name !== 'string' || typeof file?.content !== 'string') {
          throw new HttpError(400, 'each file must have a name and content');
        }
        if (file.name.includes('\0')) {
          throw new HttpError(400, 'invalid file name: contains NUL byte');
        }
        const base = basename(file.name);
        if (base.includes('\0')) {
          throw new HttpError(400, 'invalid file name: contains NUL byte');
        }
        if (Buffer.byteLength(base, 'utf8') > 255) {
          throw new HttpError(400, `file name too long: ${base.slice(0, 30)}... exceeds 255 bytes limit`);
        }
        if (!SCENE_FILE_NAME.test(base)) {
          throw new HttpError(400, `only Markdown (.md) files are supported: ${file.name}`);
        }
        if (seenNames.has(base)) {
          throw new HttpError(400, `duplicate file name in import batch: ${base}`);
        }
        seenNames.add(base);
        if (Buffer.byteLength(file.content, 'utf8') > MAX_SCENE_FILE_BYTES) {
          throw new HttpError(413, `file too large: ${file.name} exceeds 2 MB limit`);
        }
      }
      const tempDir = mkdtempSync(join(tmpdir(), 'rewrite-import-'));
      try {
        const tempPaths: string[] = [];
        for (const file of body.files as Array<{ name: string; content: string }>) {
          const tempPath = join(tempDir, basename(file.name));
          writeFileSync(tempPath, file.content, 'utf8');
          tempPaths.push(tempPath);
        }
        const result = project.importScenes(tempPaths);
        return json(res, 200, result);
      } catch (error) {
        if (error instanceof HttpError || error instanceof HcsFailure) throw error;
        if (isFsError(error)) {
          return problem(res, 409, 'file system error during import');
        }
        const msg = library.publicMessage(error);
        if (msg.includes('/tmp') || msg.includes(tmpdir())) {
          return problem(res, 409, 'file system error during import');
        }
        return problem(res, 409, msg);
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
      }
    }

    if (
      req.method === 'POST' &&
      ((parts.length === 3 && parts[2] === 'notion-inspect') ||
       (parts.length === 4 && parts[2] === 'notion' && parts[3] === 'inspect'))
    ) {
      open(IMPORT);
      const { zip } = await parseZipUpload(req, MAX_NOTION_UPLOAD_BYTES);
      try {
        const report = inspectNotion(zip);
        return json(res, 200, report);
      } catch (error) {
        if (error instanceof HttpError || error instanceof HcsFailure) throw error;
        throw new HttpError(400, (error as Error).message);
      }
    }

    if (
      req.method === 'POST' &&
      ((parts.length === 3 && parts[2] === 'notion-import') ||
       (parts.length === 4 && parts[2] === 'notion' && (parts[3] === 'import' || parts[3] === 'preview')))
    ) {
      const project = open(IMPORT);
      const { zip, mapping, dryRun } = await parseZipUpload(req, MAX_NOTION_UPLOAD_BYTES);
      if (!mapping || typeof mapping.database !== 'string' || !mapping.database.trim()) {
        throw new HttpError(400, 'missing mapping configuration');
      }
      try {
        const { chapters, missing } = loadNotionChapters(zip, mapping);

        if (dryRun) {
          const list = [
            ...chapters.map((c) => {
              const filename = chapterFilename(c.order, c.title);
              const converted = convertToMarkdown(c.body, c.format ?? 'markdown');
              return {
                order: c.order,
                title: c.title,
                file: `scenes/${filename}`,
                size: Buffer.byteLength(converted, 'utf8'),
                status: 'would_import',
              };
            }),
            ...missing.map((m) => ({
              order: m.order,
              title: m.title,
              file: m.file,
              size: 0,
              status: 'missing_page',
              reason: m.reason,
            })),
          ].sort((a, b) => a.order - b.order);

          return json(res, 200, { dryRun: true, chapters: list });
        }

        const result = importBook(project, chapters);
        for (const m of missing) {
          result.refused.push({
            order: m.order,
            title: m.title,
            file: m.file,
            reason: m.reason,
          });
        }
        return json(res, 200, result);
      } catch (error) {
        if (error instanceof HttpError || error instanceof HcsFailure) throw error;
        throw new HttpError(400, (error as Error).message);
      }
    }

    if (req.method !== 'POST' || parts.length !== 4) throw new HttpError(404, 'not found');

    const project = open(REVIEW_DECIDE);
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
        if (error instanceof HttpError || error instanceof HcsFailure) throw error;
        problem(res, 409, library.publicMessage(error));
      }
    };
    if (kind === 'claims') return refusable(() => project.reviewClaim(id, decision(), subject, note));
    if (kind === 'proposals') return refusable(() => project.reviewProposal(id, decision(), subject, note));
    if (kind === 'findings') {
      const verdict = body.verdict as VerdictKind;
      if (!VERDICTS.includes(verdict)) throw new HttpError(400, 'unknown verdict');
      return refusable(() => {
        try {
          return project.reviewFinding(id, verdict, subject, note);
        } catch (error) {
          if (error instanceof InvalidFindingVerdictError) throw new HttpError(400, error.message);
          throw error;
        }
      });
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
      if (status === 500 && !(error instanceof HcsFailure)) console.error(library.publicMessage(error));
      if (res.headersSent) {
        res.destroy();
        return;
      }
      req.resume();
      res.setHeader('connection', 'close');
      if (error instanceof HcsFailure) return hcsProblem(res, error);
      problem(res, status, status === 500 ? 'internal error' : (error as Error).message);
    });
  };
}
