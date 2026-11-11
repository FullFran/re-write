import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { EngineManager, type EngineSettings } from '../../../src/adapters/engine.ts';
import { createHandler } from '../../../src/adapters/http-server.ts';
import { tempDir } from '../../helpers.ts';
import { startHarness, type Harness } from '../../server-helpers.ts';

export interface EngineHarness {
  h: Harness;
  base: string;
  engine: EngineManager;
  key: Buffer;
  /** A browser session of the given person on this server's origin. */
  session: (subject?: string) => Promise<string>;
  api: (method: string, path: string, token?: string, body?: unknown) => Promise<Response>;
  /** Message types the fake engine processes received, in order, with `spawn` per process. */
  received: () => string[];
  /** The MCP bearer the last started fake engine process was given. */
  childToken: () => string;
  childPid: () => number;
  /** Where the fake engine program, its scenario and its records live. */
  dir: string;
  setScenario: (scenario: object) => void;
  close: () => void;
}

/** The real server with the engine enabled, and a fake engine process behind it. */
export async function startEngineHarness(scenario: object = {}, settings: Partial<EngineSettings> = {}, options: { publicResource?: string } = {}): Promise<EngineHarness> {
  const h = await startHarness();
  const dir = tempDir();
  writeFileSync(join(dir, 'main.ts'), `import ${JSON.stringify(join(import.meta.dirname, 'fake-child.ts'))};\n`);
  const setScenario = (value: object) => writeFileSync(join(dir, 'scenario.json'), JSON.stringify(value));
  setScenario(scenario);

  const app = createServer();
  await new Promise<void>((resolve) => app.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(app.address() as AddressInfo).port}`;
  const key = randomBytes(32);
  const engineSettings: EngineSettings = { key, dataDir: h.data, entry: join(dir, 'main.ts'), mcpUrl: `${base}/mcp`, maxProcesses: 2, idleMs: 60_000, ...settings };
  const engine = new EngineManager(engineSettings);
  // With `publicResource` the server has a public name, as in production, and the engine dials loopback.
  app.on('request', createHandler({ ...h.config, resource: options.publicResource ?? `${base}/mcp`, reviewOrigin: base, engine: engineSettings }, h.library, engine));

  return {
    h,
    base,
    engine,
    key,
    session: (subject = 'user_fran') => h.session(subject, { azp: base }),
    api: (method, path, token, body) => fetch(`${base}/review/api/engine${path}`, {
      method,
      headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
    received: () => existsSync(join(dir, 'received.log')) ? readFileSync(join(dir, 'received.log'), 'utf8').trim().split('\n') : [],
    childToken: () => readFileSync(join(dir, 'token.txt'), 'utf8'),
    childPid: () => Number(readFileSync(join(dir, 'pid.txt'), 'utf8')),
    dir,
    setScenario,
    close: () => {
      void engine.close();
      app.closeAllConnections();
      app.close();
      h.close();
    },
  };
}

export interface SseEvent { event: string; data: any }

export function parseSse(text: string): SseEvent[] {
  return text.split('\n\n').filter((block) => block.trim()).map((block) => {
    const event = /^event: (.*)$/m.exec(block)?.[1] ?? '';
    const data = /^data: (.*)$/m.exec(block)?.[1] ?? 'null';
    return { event, data: JSON.parse(data) };
  });
}

export async function until(check: () => boolean | Promise<boolean>, ms = 10_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error('condition not met in time');
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
}
