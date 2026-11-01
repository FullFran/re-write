#!/usr/bin/env node
import { createServer } from 'node:http';
import { createHandler, readConfig } from '../adapters/http-server.ts';
import { Library } from '../application/library.ts';

let settings;
try {
  settings = readConfig(process.env);
} catch (error) {
  console.error(`cannot start: ${(error as Error).message}`);
  process.exit(1);
}

const { config, dataDir, port } = settings;
const server = createServer(createHandler(config, new Library(dataDir)));
server.listen(port, () => console.log(`RE;write listening on ${port}, public address ${config.resource}`));

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
