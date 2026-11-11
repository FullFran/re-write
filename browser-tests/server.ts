/**
 * One test's world: the real server over a fresh synthetic book, and a fake Clerk on
 * loopback. The fake Clerk is a JWKS endpoint for our own keys plus a stand-in for the
 * two scripts the page loads from the issuer, so the page runs its own code against the
 * real server and nothing reaches the network. Run with Node 24 (types are stripped);
 * it prints one JSON line with the addresses and exits when its stdin closes.
 *
 * With `--engine` the embedded engine is on, behind a stand-in engine process (below) that
 * calls no model: it logs in at once and answers each prompt by echoing its first line.
 */
import { randomBytes } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { Library } from '../src/application/library.ts';
import { createHandler, type ServerConfig } from '../src/adapters/http-server.ts';
import { cli, FIXTURES, tempDir } from '../tests/helpers.ts';

process.env.GIT_CONFIG_GLOBAL = '/dev/null';
process.env.GIT_CONFIG_NOSYSTEM = '1';
process.env.HOME = tempDir();

const BOOK = 'sal';

// The stand-in engine process: protocol of src/adapters/engine-protocol.ts, no model. Its
// answer quotes the first line it was given, so a test can see the host context line.
const ENGINE_CHILD = String.raw`
const send = (m) => process.stdout.write(JSON.stringify(m) + '\n');
send({ type: 'ready', piVersion: '0.0.0-browser' });
let buffer = '';
process.stdin.on('data', (chunk) => {
  buffer += chunk.toString('utf8');
  let i;
  while ((i = buffer.indexOf('\n')) >= 0) {
    const m = JSON.parse(buffer.slice(0, i));
    buffer = buffer.slice(i + 1);
    if (m.type === 'login.start') {
      send({ type: 'login.code', userCode: 'ECHO-1234' });
      setTimeout(() => send({ type: 'login.done', credential: { access: 'a', refresh: 'r', expires: Date.now() + 3600000, accountId: 'acc' } }), 1500);
    }
    if (m.type === 'prompt') {
      send({ type: 'session', tools: ['mcp__rewrite__read_scene'] });
      send({ type: 'tool', phase: 'start', call: 1, name: 'mcp__rewrite__read_scene', scene: 'scenes/escena-01.md' });
      send({ type: 'tool', phase: 'end', call: 1, name: 'mcp__rewrite__read_scene', ok: true, scene: 'scenes/escena-01.md' });
      send({ type: 'delta', text: '**Recibido:**\n\n> ' + m.text.split('\n')[0] + '\n\n- uno\n- dos' });
      send({ type: 'done' });
    }
    if (m.type === 'shutdown') process.exit(0);
  }
});
process.stdin.on('end', () => process.exit(0));
`;
const USER = 'user_fran';

function listen(server: Server): Promise<string> {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`));
  });
}

// The page uses only these members of Clerk: load, isSignedIn, session.getToken,
// mountSignIn and mountUserButton. The session token is a real one for this issuer.
function clerkScript(token: string): string {
  return `window.Clerk = {
  isSignedIn: false,
  session: null,
  async load() {
    this.isSignedIn = true;
    this.session = { getToken: async () => ${JSON.stringify(token)} };
  },
  mountSignIn(node) { node.textContent = 'Inicia sesión'; },
  mountUserButton(node) {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = 'Cuenta';
    node.append(button);
  },
};
`;
}

const { publicKey, privateKey } = await generateKeyPair('RS256');
const jwk = { ...(await exportJWK(publicKey)), kid: 'key-1', use: 'sig', alg: 'RS256' };
let script = '';
const provider = createServer((req, res) => {
  const send = (type: string, body: string) => {
    res.setHeader('content-type', type);
    // The page loads both scripts with crossorigin="anonymous".
    res.setHeader('access-control-allow-origin', '*');
    res.end(body);
  };
  if (req.url === '/.well-known/jwks.json') return send('application/json', JSON.stringify({ keys: [jwk] }));
  if (req.url === '/npm/@clerk/clerk-js@6/dist/clerk.browser.js') return send('text/javascript', script);
  if (req.url === '/npm/@clerk/ui@1/dist/ui.browser.js') return send('text/javascript', 'window.__internal_ClerkUICtor = class {};\n');
  res.statusCode = 404;
  res.end();
});
const issuer = await listen(provider);

const data = tempDir();
const bookDir = join(data, 'books', BOOK);
for (const args of [['init', bookDir, '--title', 'La puerta de Sal'], ['import', bookDir, join(FIXTURES, 'escena-01.md'), join(FIXTURES, 'escena-02.md')]]) {
  const run = cli(...args);
  if (run.code !== 0) throw new Error(run.stderr);
}
const library = new Library(data);
library.grant(BOOK, USER);

const app = createServer();
const base = await listen(app);
const config: ServerConfig = { issuer, resource: `${base}/mcp`, reviewOrigin: base, clerkPublishableKey: 'pk_test_placeholder' };
if (process.argv.includes('--engine')) {
  const entry = join(tempDir(), 'engine-child.mjs');
  writeFileSync(entry, ENGINE_CHILD);
  config.engine = { key: randomBytes(32), dataDir: data, entry, mcpUrl: `${base}/mcp`, maxProcesses: 2, idleMs: 60_000 };
}
app.on('request', createHandler(config, library));

script = clerkScript(await new SignJWT({ iss: issuer, sub: USER, sid: 'sess_1', azp: base })
  .setProtectedHeader({ alg: 'RS256', kid: 'key-1' })
  .setIssuedAt()
  .setExpirationTime('1h')
  .sign(privateKey));

const stop = () => {
  app.closeAllConnections();
  app.close();
  provider.closeAllConnections();
  provider.close();
  process.exit(0);
};
process.stdin.on('end', stop);
process.stdin.resume();
process.on('SIGTERM', stop);
process.stdout.write(JSON.stringify({ base, book: BOOK, bookDir }) + '\n');
