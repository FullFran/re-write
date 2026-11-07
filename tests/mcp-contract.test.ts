import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Library } from '../src/application/library.ts';
import { buildMcpServer } from '../src/adapters/mcp.ts';

const fixture = new URL('./fixtures/mcp-baseline.json', import.meta.url);

test('MCP public contract matches the unchanged baseline', async (t) => {
  const data = mkdtempSync(join(tmpdir(), 'rewrite-mcp-contract-'));
  t.diagnostic(`scratch: ${data}`);
  t.after(() => rmSync(data, { recursive: true, force: true }));
  const book = join(data, 'books', 'example');
  const scene = join(data, 'scene.md');
  writeFileSync(scene, 'Ari opened the quiet gate.\n');
  const cli = (...args: string[]) => {
    const result = spawnSync(process.execPath, [resolve('src/cli/main.ts'), ...args, '--json'], {
      encoding: 'utf8',
      env: { PATH: process.env.PATH, HOME: data, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' },
    });
    assert.equal(result.status, 0, `CLI ${args[0]} failed: ${result.stderr}`);
  };
  cli('init', book, '--title', 'Synthetic book');
  cli('import', book, scene);
  const lib = new Library(data);
  lib.grant('example', 'user_test');
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await buildMcpServer(lib, 'user_test').connect(serverSide);
  const client = new Client({ name: 'test', version: '1' });
  await client.connect(clientSide);
  t.after(() => client.close());

  const actual = {
    tools: (await client.listTools()).tools.map(({ name, description, inputSchema, annotations }) => ({ name, description, inputSchema, annotations })),
    instructions: client.getInstructions(),
    read: await client.callTool({ name: 'read_scene', arguments: { book: 'example', file: 'scenes/scene.md' } }),
    propose: await client.callTool({ name: 'propose_claims', arguments: {
      book: 'example', extractor: 'test', candidates: [{
        statement: 'Ari opened the gate.', subject: 'Ari', source_file: 'scenes/scene.md',
        quote: 'Ari opened the quiet gate.', scope: 'book', epistemic_kind: 'narrated_fact',
      }],
    } }),
  };
  assert.deepEqual(actual, JSON.parse(readFileSync(fixture, 'utf8')));
});
