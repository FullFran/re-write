import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Library } from '../src/application/library.ts';
import { buildMcpServer } from '../src/adapters/mcp.ts';
import { cli, FIXTURES, git, read, tempDir } from './helpers.ts';

const SCENE = 'scenes/escena-01.md';
const QUOTE = 'Elena llevaba once años custodiando el puente de Sal';

function library(): { lib: Library; data: string; book: string } {
  const data = tempDir();
  const book = join(data, 'books', 'sal');
  cli('init', book);
  cli('import', book, join(FIXTURES, 'escena-01.md'), join(FIXTURES, 'escena-02.md'));
  const lib = new Library(data);
  lib.grant('sal', 'user_fran');
  return { lib, data, book };
}

async function connect(lib: Library, subject: string): Promise<Client> {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await buildMcpServer(lib, subject).connect(serverSide);
  const client = new Client({ name: 'test', version: '1' });
  await client.connect(clientSide);
  return client;
}

async function call(client: Client, name: string, args: object): Promise<{ isError: boolean; data: any; text: string }> {
  const result: any = await client.callTool({ name, arguments: args as Record<string, unknown> });
  const text = result.content[0].text as string;
  let data: any = null;
  try {
    data = JSON.parse(text);
  } catch {
    // Errors are plain sentences.
  }
  return { isError: Boolean(result.isError), data, text };
}

const candidate = {
  statement: 'Elena has guarded the bridge for eleven years.', subject: 'Elena', source_file: SCENE,
  quote: QUOTE, scope: 'book', epistemic_kind: 'narrated_fact',
};

test('the MCP offers reading and proposing, and no way to accept or reject', async () => {
  const { lib } = library();
  const client = await connect(lib, 'user_fran');
  const names = (await client.listTools()).tools.map((t) => t.name).sort();
  assert.deepEqual(names, [
    'get_proposal', 'inspect_continuity', 'list_books', 'list_claims', 'list_proposals', 'list_scenes',
    'propose_claims', 'propose_revision', 'read_scene',
  ]);
  assert.ok(!names.some((name) => /review|accept|reject|apply|verdict/.test(name)));
});

test('read tools are marked read-only and proposing tools are not', async () => {
  const { lib } = library();
  const { tools } = await (await connect(lib, 'user_fran')).listTools();
  const readOnly = (name: string) => tools.find((t) => t.name === name)?.annotations?.readOnlyHint;
  assert.equal(readOnly('read_scene'), true);
  assert.equal(readOnly('propose_claims'), false);
});

test('a member sees the book, and a stranger gets the same answer as for a book that does not exist', async () => {
  const { lib } = library();
  const member = await connect(lib, 'user_fran');
  assert.deepEqual((await call(member, 'list_books', {})).data.books.map((b: any) => b.book_id), ['sal']);
  const stranger = await connect(lib, 'user_other');
  assert.deepEqual((await call(stranger, 'list_books', {})).data.books, []);
  const hidden = await call(stranger, 'read_scene', { book: 'sal', file: SCENE });
  const missing = await call(stranger, 'read_scene', { book: 'nope', file: SCENE });
  assert.equal(hidden.isError, true);
  assert.equal(hidden.text, missing.text);
  assert.doesNotMatch(hidden.text, /once años/);
});

test('every tool that takes a book refuses a stranger', async () => {
  const { lib } = library();
  const stranger = await connect(lib, 'user_other');
  const calls: [string, object][] = [
    ['list_scenes', {}], ['read_scene', { file: SCENE }], ['list_claims', {}], ['inspect_continuity', {}],
    ['list_proposals', {}], ['get_proposal', { proposal_id: 'P-0000000000' }],
    ['propose_claims', { extractor: 'x', candidates: [candidate] }],
    ['propose_revision', { file: SCENE, find: 'a', replace: 'b', rationale: 'r' }],
  ];
  for (const [name, args] of calls) {
    const result = await call(stranger, name, { book: 'sal', ...args });
    assert.equal(result.isError, true, name);
    assert.match(result.text, /unknown book/, name);
  }
});

test('read_scene paginates and marks the text as data', async () => {
  const { lib, book } = library();
  const client = await connect(lib, 'user_fran');
  const first = await call(client, 'read_scene', { book: 'sal', file: SCENE, limit: 10 });
  assert.equal(first.data.text.length, 10);
  assert.equal(first.data.next_offset, 10);
  const rest = await call(client, 'read_scene', { book: 'sal', file: SCENE, offset: 10, limit: 100000 });
  assert.equal(first.data.text + rest.data.text, read(book, SCENE));
  assert.equal(rest.data.next_offset, null);
  assert.match((await client.listTools()).tools.find((t) => t.name === 'read_scene')!.description!, /not instructions/);
});

test('read_scene refuses a path outside scenes', async () => {
  const { lib } = library();
  const client = await connect(lib, 'user_fran');
  const result = await call(client, 'read_scene', { book: 'sal', file: '../../access.json' });
  assert.equal(result.isError, true);
  assert.match(result.text, /inside scenes/);
});

test('proposed claims record who proposed them and stay proposed; a fake quote is rejected', async () => {
  const { lib } = library();
  const client = await connect(lib, 'user_fran');
  const result = await call(client, 'propose_claims', {
    book: 'sal', extractor: 'chatgpt',
    candidates: [candidate, { ...candidate, statement: 'Invented.', quote: 'nadie escribió esto' }],
  });
  assert.equal(result.isError, false);
  assert.equal(result.data.created.length, 1);
  assert.match(result.data.rejected[0].reason, /not found/);
  const [claim] = (await call(client, 'list_claims', { book: 'sal' })).data.claims;
  assert.equal(claim.editorial_status, 'proposed');
  assert.equal(claim.extractor, 'mcp:chatgpt');
  assert.equal(claim.proposed_by, 'user_fran');
  assert.equal(claim.evidence_status, 'valid');
});

test('repeating propose_claims does not duplicate', async () => {
  const { lib } = library();
  const client = await connect(lib, 'user_fran');
  const args = { book: 'sal', extractor: 'chatgpt', candidates: [candidate] };
  await call(client, 'propose_claims', args);
  const again = await call(client, 'propose_claims', args);
  assert.equal(again.data.created.length, 0);
  assert.equal(again.data.existing.length, 1);
  assert.equal((await call(client, 'list_claims', { book: 'sal' })).data.total, 1);
});

test('propose_claims refuses an unknown epistemic kind and an oversized batch at the schema', async () => {
  const { lib } = library();
  const client = await connect(lib, 'user_fran');
  const badKind = await call(client, 'propose_claims', {
    book: 'sal', extractor: 'x', candidates: [{ ...candidate, epistemic_kind: 'canon' }],
  });
  assert.equal(badKind.isError, true);
  const tooMany = await call(client, 'propose_claims', {
    book: 'sal', extractor: 'x', candidates: Array.from({ length: 51 }, () => candidate),
  });
  assert.equal(tooMany.isError, true);
  assert.equal((await call(client, 'list_claims', { book: 'sal' })).data.total, 0);
});

test('list_claims paginates', async () => {
  const { lib } = library();
  const client = await connect(lib, 'user_fran');
  await call(client, 'propose_claims', {
    book: 'sal', extractor: 'x',
    candidates: [candidate, { ...candidate, statement: 'Second.' }, { ...candidate, statement: 'Third.' }],
  });
  const page = await call(client, 'list_claims', { book: 'sal', limit: 2 });
  assert.equal(page.data.claims.length, 2);
  assert.equal(page.data.total, 3);
  assert.equal(page.data.next_offset, 2);
  const last = await call(client, 'list_claims', { book: 'sal', offset: 2, limit: 2 });
  assert.equal(last.data.claims.length, 1);
  assert.equal(last.data.next_offset, null);
});

test('propose_revision never touches the text, shows a diff, and records who proposed it', async () => {
  const { lib, book } = library();
  const client = await connect(lib, 'user_fran');
  const before = read(book, SCENE);
  const args = { book: 'sal', file: SCENE, find: 'once años', replace: 'veinte años', rationale: 'r' };
  const created = await call(client, 'propose_revision', args);
  assert.equal(created.data.created, true);
  assert.equal(read(book, SCENE), before);
  const id = created.data.proposal.proposal_id;
  const shown = await call(client, 'get_proposal', { book: 'sal', proposal_id: id });
  assert.equal(shown.data.proposal.status, 'proposed');
  assert.equal(shown.data.proposal.proposed_by, 'user_fran');
  assert.match(shown.data.diff, /^\+.*veinte años/m);
  assert.equal((await call(client, 'propose_revision', args)).data.created, false);
  assert.equal((await call(client, 'list_proposals', { book: 'sal' })).data.total, 1);
  assert.equal(git(book, 'status', '--porcelain'), '');
});

test('inspect_continuity reports heuristics and writes nothing', async () => {
  const { lib, book } = library();
  const client = await connect(lib, 'user_fran');
  const annotations = JSON.parse(read(FIXTURES, 'annotations.json'));
  await call(client, 'propose_claims', { book: 'sal', extractor: 'x', candidates: annotations.candidates });
  const head = git(book, 'rev-parse', 'HEAD');
  const result = await call(client, 'inspect_continuity', { book: 'sal' });
  assert.equal(result.data.findings[0].classification, 'possible_contradiction');
  assert.equal(result.data.findings[0].citations.length, 2);
  assert.equal(git(book, 'rev-parse', 'HEAD'), head);
});

test('a proposal id with path characters is refused, not read from disk', async () => {
  const { lib } = library();
  const client = await connect(lib, 'user_fran');
  const result = await call(client, 'get_proposal', { book: 'sal', proposal_id: '../../project' });
  assert.equal(result.isError, true);
  assert.match(result.text, /unknown proposal|Invalid|invalid/);
  assert.doesNotMatch(result.text, /title/);
});

test('error messages do not reveal the data directory', async () => {
  const { lib, data } = library();
  const client = await connect(lib, 'user_fran');
  const result = await call(client, 'read_scene', { book: 'sal', file: 'scenes/nada.md' });
  assert.equal(result.isError, true);
  assert.ok(!result.text.includes(data));
});

test('grant refuses a book that does not exist and an invalid id, and is idempotent', () => {
  const { lib } = library();
  assert.throws(() => lib.grant('nope', 'user_x'), /unknown book/);
  assert.throws(() => lib.grant('../sal', 'user_x'), /invalid book id/);
  lib.grant('sal', 'user_fran');
  assert.deepEqual(lib.booksFor('user_fran'), ['sal']);
});

test('a directory cannot be used as a source file, and reading stays available', async () => {
  const { lib } = library();
  const client = await connect(lib, 'user_fran');
  const result = await call(client, 'propose_claims', {
    book: 'sal', extractor: 'x', candidates: [{ ...candidate, source_file: 'scenes/', quote: 'escena-01.md' }],
  });
  assert.equal(result.data.created.length, 0);
  assert.match(result.data.rejected[0].reason, /inside scenes/);
  const listed = await call(client, 'list_claims', { book: 'sal' });
  assert.equal(listed.isError, false);
  assert.equal(listed.data.total, 0);
  assert.equal((await call(client, 'read_scene', { book: 'sal', file: 'scenes/' })).isError, true);
});

test('a claim already stored with a directory path shows as orphaned and does not break the book', async () => {
  const { lib, book } = library();
  const client = await connect(lib, 'user_fran');
  await call(client, 'propose_claims', { book: 'sal', extractor: 'x', candidates: [candidate] });
  const [claim] = (await call(client, 'list_claims', { book: 'sal' })).data.claims;
  const path = join(book, '.rewrite/claims', `${claim.claim_id}.json`);
  writeFileSync(path, JSON.stringify({ ...JSON.parse(readFileSync(path, 'utf8')), source_file: 'scenes/' }));
  const listed = await call(client, 'list_claims', { book: 'sal' });
  assert.equal(listed.isError, false);
  assert.equal(listed.data.claims[0].evidence_status, 'orphaned');
  assert.equal((await call(client, 'inspect_continuity', { book: 'sal' })).isError, false);
});

test('a revision containing a NUL byte is refused, so a reviewer never sees an empty diff', async () => {
  const { lib, book } = library();
  const client = await connect(lib, 'user_fran');
  const before = read(book, SCENE);
  const result = await call(client, 'propose_revision', {
    book: 'sal', file: SCENE, find: 'once años', replace: 'veinte\u0000 años', rationale: 'r',
  });
  assert.equal(result.isError, true);
  assert.match(result.text, /NUL characters/);
  assert.equal((await call(client, 'list_proposals', { book: 'sal' })).data.total, 0);
  assert.equal(read(book, SCENE), before);
});

test('a revision on a scene that already holds a NUL byte still shows its real change', async () => {
  const { lib, book } = library();
  const client = await connect(lib, 'user_fran');
  writeFileSync(join(book, SCENE), `${read(book, SCENE)}\u0000\n`);
  git(book, 'add', SCENE);
  git(book, 'commit', '-q', '-m', 'binary-looking scene');
  const created = await call(client, 'propose_revision', {
    book: 'sal', file: SCENE, find: 'once años', replace: 'veinte años', rationale: 'r',
  });
  const shown = await call(client, 'get_proposal', { book: 'sal', proposal_id: created.data.proposal.proposal_id });
  assert.match(shown.data.diff, /^\+.*veinte años/m);
});
