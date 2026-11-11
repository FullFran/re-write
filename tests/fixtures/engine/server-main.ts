/**
 * A server process shaped like `src/server/main.ts`, for the shutdown test: it holds one
 * engine process and handles SIGTERM and SIGINT the way the real entry point does.
 * Arguments: the engine entry file and a data directory.
 */
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { EngineManager } from '../../../src/adapters/engine.ts';

const [entry, dataDir] = process.argv.slice(2);
const engine = new EngineManager({ key: Buffer.alloc(32, 1), dataDir, entry, mcpUrl: 'http://127.0.0.1:1/mcp', maxProcesses: 2, idleMs: 60_000 });
// Requests are never answered, so an open connection keeps `server.close` from completing.
const server = createServer(() => { console.log('held'); });
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
server.listen(0, '127.0.0.1', async () => {
  await engine.startLogin('user_fran');
  console.log(`ready ${(server.address() as AddressInfo).port}`);
});
