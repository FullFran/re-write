import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { exportJWK, generateKeyPair, SignJWT, type CryptoKey } from 'jose';
import { Library } from '../src/application/library.ts';
import { createHandler, type ServerConfig } from '../src/adapters/http-server.ts';
import { cli, FIXTURES, tempDir } from './helpers.ts';

// The server runs in this process, so it gets the same clean git environment as the CLI tests.
process.env.GIT_CONFIG_GLOBAL = '/dev/null';
process.env.GIT_CONFIG_NOSYSTEM = '1';
process.env.HOME = tempDir();

function listen(server: Server): Promise<string> {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`));
  });
}

export interface Harness {
  base: string;
  resource: string;
  issuer: string;
  data: string;
  bookDir: string;
  config: ServerConfig;
  library: Library;
  sign: (claims: Record<string, unknown>, options?: { key?: CryptoKey; kid?: string; expires?: string | Date }) => Promise<string>;
  access: (subject?: string, claims?: Record<string, unknown>) => Promise<string>;
  session: (subject?: string, claims?: Record<string, unknown>) => Promise<string>;
  strangerKey: CryptoKey;
  jwksHits: () => number;
  close: () => void;
}

/** A fake Clerk (a JWKS endpoint and our own keys) and the real server, on loopback. */
export async function startHarness(): Promise<Harness> {
  const { publicKey, privateKey } = await generateKeyPair('RS256');
  const stranger = await generateKeyPair('RS256');
  const jwk = { ...(await exportJWK(publicKey)), kid: 'key-1', use: 'sig', alg: 'RS256' };
  let hits = 0;
  const provider = createServer((req, res) => {
    if (req.url === '/.well-known/jwks.json') {
      hits += 1;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ keys: [jwk] }));
      return;
    }
    res.statusCode = 404;
    res.end();
  });
  const issuer = await listen(provider);

  const data = tempDir();
  const bookDir = join(data, 'books', 'sal');
  cli('init', bookDir, '--title', 'La puerta de Sal');
  cli('import', bookDir, join(FIXTURES, 'escena-01.md'), join(FIXTURES, 'escena-02.md'));
  const library = new Library(data);
  library.grant('sal', 'user_fran');

  const app = createServer();
  const base = await listen(app);
  const resource = `${base}/mcp`;
  const config: ServerConfig = {
    issuer,
    resource,
    reviewOrigin: base,
    clerkPublishableKey: 'pk_test_placeholder',
  };
  app.on('request', createHandler(config, library));

  const sign: Harness['sign'] = (claims, options = {}) => {
    const token = new SignJWT(claims)
      .setProtectedHeader({ alg: 'RS256', kid: options.kid ?? 'key-1' })
      .setIssuedAt()
      .setExpirationTime(options.expires ?? '5m');
    return token.sign(options.key ?? privateKey);
  };

  return {
    base,
    resource,
    issuer,
    data,
    bookDir,
    config,
    library,
    sign,
    access: (subject = 'user_fran', claims = {}) => sign({ iss: issuer, aud: resource, sub: subject, client_id: 'chatgpt', ...claims }),
    session: (subject = 'user_fran', claims = {}) => sign({ iss: issuer, sub: subject, sid: 'sess_1', azp: base, ...claims }),
    strangerKey: stranger.privateKey,
    jwksHits: () => hits,
    close: () => {
      app.closeAllConnections();
      app.close();
      provider.closeAllConnections();
      provider.close();
    },
  };
}

/** Makes an HTTP request to the review API of the harness. */
export function reviewApi(h: Harness, path: string, token?: string, body?: unknown): Promise<Response> {
  return fetch(`${h.base}/review/api${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

/** Creates a revision proposal through the CLI against the book in the harness. */
export function proposeRevision(bookDir: string, file: string, find: string, replace: string, rationale = 'editorial revision'): string {
  return cli('propose', bookDir, '--file', file, '--find', find, '--replace', replace, '--rationale', rationale).json.proposal.proposal_id;
}

