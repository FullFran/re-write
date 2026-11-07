import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Library } from '../src/application/library.ts';
import { buildMcpServer } from '../src/adapters/mcp.ts';
import { HcsFailure, hcsError } from '../src/hcs/errors.ts';
import { REWRITE_CAPABILITIES, REWRITE_PERMISSIONS, REVIEW_DECIDE } from '../src/hcs/ids.ts';
import { grantPermission, revokePermission } from '../src/hcs/grants.ts';
import { decide } from '../src/application/decision.ts';
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

async function connect(lib: Library, subject: string, capabilities?: any): Promise<Client> {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await buildMcpServer(lib, subject, capabilities).connect(serverSide);
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

test('MCP pins one snapshot, filters tools, and dispatches draining capabilities', async () => {
  const { lib } = library();
  const bookRef = 'com.fullfran.rewrite.book.read@1';
  const claimRef = 'com.fullfran.rewrite.claims.read@1';
  let state = { generation: 1, active: new Set([claimRef]), draining: new Set([claimRef]) };
  let snapshots = 0;
  const provider = { snapshot: () => { snapshots++; return state; } };
  const first = await connect(lib, 'user_fran', provider);
  state = { generation: 2, active: new Set([bookRef]), draining: new Set() };
  const second = await connect(lib, 'user_fran', provider);
  assert.equal(snapshots, 2);
  assert.deepEqual((await first.listTools()).tools.map(t => t.name), ['list_claims']);
  assert.deepEqual((await second.listTools()).tools.map(t => t.name), ['list_books', 'list_scenes', 'read_scene']);
  await assert.rejects(first.callTool({ name: 'list_claims', arguments: { book: 'sal' } }), (e: any) => {
    assert.equal(e.code, -32000);
    assert.equal(e.data.hcsError.code, 'unsupported_capability');
    assert.equal(e.data.hcsError.capability, claimRef);
    assert.equal(e.data.hcsError.requirement, 'HCS-0004-R006');
    return true;
  });
  assert.deepEqual((await call(second, 'list_books', {})).data.books.map((b: any) => b.book_id), ['sal']);
});

test('MCP rejects colliding tool names and never registers the review capability', async () => {
  const { lib } = library();
  const table = [...REWRITE_CAPABILITIES, { ref: 'com.fullfran.rewrite.other@1', mcpTools: ['list_books'] }];
  assert.throws(() => buildMcpServer(lib, 'user_fran', undefined, table), /list_books/);
  assert.ok(!REWRITE_CAPABILITIES.some(c => c.ref === REVIEW_DECIDE));
  const names = (await (await connect(lib, 'user_fran')).listTools()).tools.map(t => t.name);
  assert.ok(!names.some(name => /accept|approve|reject|decide/.test(name)));
});

test('MCP refuses an active capability with no tool implementation', () => {
  const { lib } = library();
  const ref = 'com.fullfran.rewrite.missing@1';
  const provider = { snapshot: () => ({ generation: 1, active: new Set([ref]), draining: new Set<string>() }) };
  assert.throws(() => buildMcpServer(lib, 'user_fran', provider, [{ ref, mcpTools: ['missing_tool'] }]), /missing_tool/);
});

test('MCP pins snapshot contents even if the provider mutates its sets', async () => {
  const { lib } = library();
  const ref = 'com.fullfran.rewrite.book.read@1';
  const active = new Set([ref, 'com.fullfran.rewrite.claims.read@1']);
  const provider = { snapshot: () => ({ generation: 1, active, draining: new Set<string>() }) };
  const first = await connect(lib, 'user_fran', provider);
  active.delete(ref);
  const second = await connect(lib, 'user_fran', provider);
  assert.deepEqual((await first.listTools()).tools.map(t => t.name), ['list_books', 'list_scenes', 'read_scene', 'list_claims']);
  assert.deepEqual((await second.listTools()).tools.map(t => t.name), ['list_claims']);
  assert.deepEqual((await call(first, 'list_books', {})).data.books.map((b: any) => b.book_id), ['sal']);
});

test('MCP lists no tools for an empty capability snapshot', async () => {
  const { lib } = library();
  const client = await connect(lib, 'user_fran', { snapshot: () => ({ generation: 1, active: new Set(), draining: new Set() }) });
  assert.deepEqual(await client.listTools(), { tools: [] });
});

test('MCP carries an HCS failure as a JSON-RPC error', async () => {
  const { lib } = library();
  const error = hcsError('timeout', 'Timed out');
  lib.booksFor = () => { throw new HcsFailure([error]); };
  const client = await connect(lib, 'user_fran');
  await assert.rejects(client.callTool({ name: 'list_books', arguments: {} }), (failure: any) => {
    assert.equal(failure.code, -32000);
    assert.deepEqual(failure.data, { hcsError: error });
    return true;
  });
});

test('MCP product refusals expose a problem without revealing hidden books', async () => {
  const { lib } = library();
  const stranger = await connect(lib, 'user_other');
  const hidden: any = await stranger.callTool({ name: 'list_scenes', arguments: { book: 'sal' } });
  const missing: any = await stranger.callTool({ name: 'list_scenes', arguments: { book: 'nope' } });
  assert.equal(hidden.isError, true);
  assert.deepEqual(hidden.structuredContent, missing.structuredContent);
  assert.match(hidden.structuredContent.type, /^https:\/\/github\.com\/FullFran\/re-write\/blob\/main\/docs\/problems\.md#/);
  assert.equal('hcsError' in hidden.structuredContent, false);
});

const candidate = {
  statement: 'Elena has guarded the bridge for eleven years.', subject: 'Elena', source_file: SCENE,
  quote: QUOTE, scope: 'book', epistemic_kind: 'narrated_fact',
};

test('MCP schema refusals carry an invalid-input problem without changing claims', async () => {
  const { lib } = library();
  const client = await connect(lib, 'user_fran');
  const result: any = await client.callTool({ name: 'propose_claims', arguments: { book: 'sal', extractor: 'x', candidates: [] } });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /Invalid arguments/);
  assert.equal(result.structuredContent.type, 'https://github.com/FullFran/re-write/blob/main/docs/problems.md#invalid-input');
  assert.equal(result.structuredContent.status, 400);
  assert.equal(result.structuredContent.detail, result.content[0].text);
  assert.equal('hcsError' in result.structuredContent, false);
  assert.equal((await call(client, 'list_claims', { book: 'sal' })).data.total, 0);
});

test('MCP rejected quote retains its reason and adds a product problem', async () => {
  const { lib } = library();
  const client = await connect(lib, 'user_fran');
  const result = await call(client, 'propose_claims', { book: 'sal', extractor: 'x', candidates: [{ ...candidate, quote: 'not a literal quote' }] });
  assert.equal(result.isError, false);
  assert.equal(result.data.created.length, 0);
  assert.equal(result.data.existing.length, 0);
  const rejected = result.data.rejected[0];
  assert.match(rejected.reason, /quote not found/);
  assert.equal(rejected.problem.type, 'https://github.com/FullFran/re-write/blob/main/docs/problems.md#quote-not-literal');
  assert.equal(rejected.problem.detail, rejected.reason);
  assert.equal('hcsError' in rejected.problem, false);
  assert.equal((await call(client, 'list_claims', { book: 'sal' })).data.total, 0);
});

test('the MCP offers reading and proposing, and no way to accept or reject', async () => {
  const { lib } = library();
  const client = await connect(lib, 'user_fran');
  const names = (await client.listTools()).tools.map((t) => t.name).sort();
  assert.deepEqual(names, [
    'get_analysis_guide', 'get_proposal', 'inspect_continuity', 'list_books', 'list_claims', 'list_findings', 'list_proposals', 'list_scenes',
    'propose_claims', 'propose_findings', 'propose_revision', 'read_scene',
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

const READ = 'com.fullfran.rewrite.book.read';
const PACKAGE = 'com.example.reader';

async function connectAs(lib: Library, subject: string, entry: string | null): Promise<Client> {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await buildMcpServer(lib, subject, undefined, undefined, entry).connect(serverSide);
  const client = new Client({ name: 'test', version: '1' });
  await client.connect(clientSide);
  return client;
}

function deniedBy(code: string, permission: string) {
  return (failure: any) => {
    assert.equal(failure.code, -32000);
    assert.equal(failure.data.hcsError.code, code);
    assert.equal(failure.data.hcsError.entry, PACKAGE);
    assert.equal(failure.data.hcsError.requirement, 'HCS-0005-R001');
    assert.equal(failure.data.hcsError.message, `Permission denied: ${permission}`);
    return true;
  };
}

const BOOK_TOOLS: [string, Record<string, unknown>][] = [
  ['list_scenes', {}], ['read_scene', { file: SCENE }], ['list_claims', {}],
  ['propose_claims', { extractor: 'x', candidates: [candidate] }], ['inspect_continuity', {}],
  ['propose_revision', { file: SCENE, find: 'once años', replace: 'doce años', rationale: 'r' }],
  ['list_proposals', {}], ['get_proposal', { proposal_id: 'p-1' }],
  ['list_findings', {}],
  ['propose_findings', { findings: [{ question: 'motivation', kind: 'fact', statement: 's', evidence: [{ file: SCENE, quote: QUOTE }] }] }],
];

test('MCP checks the package grant of every tool at dispatch, and a revocation denies the next call (HCS-0005-R001, R003)', async () => {
  const { lib, data, book } = library();
  const client = await connectAs(lib, 'user_fran', PACKAGE);
  await assert.rejects(client.callTool({ name: 'list_books', arguments: {} }), deniedBy('permission_denied', READ));
  for (const [name, args] of BOOK_TOOLS) {
    const permission = name === 'propose_claims' ? 'com.fullfran.rewrite.claims.propose'
      : name === 'propose_revision' ? 'com.fullfran.rewrite.revision.propose'
      : name === 'propose_findings' ? 'com.fullfran.rewrite.findings.propose' : READ;
    await assert.rejects(client.callTool({ name, arguments: { book: 'sal', ...args } }), deniedBy('permission_denied', permission), name);
  }
  grantPermission(data, PACKAGE, READ);
  assert.deepEqual((await call(client, 'list_books', {})).data.books.map((b: any) => b.book_id), ['sal']);
  assert.equal((await call(client, 'list_scenes', { book: 'sal' })).isError, false);
  assert.equal((await call(client, 'list_scenes', { book: 'sal' })).isError, false, 'a held grant allows every call');
  await assert.rejects(client.callTool({ name: 'propose_claims', arguments: { book: 'sal', extractor: 'x', candidates: [candidate] } }),
    deniedBy('permission_denied', 'com.fullfran.rewrite.claims.propose'));
  await assert.rejects(client.callTool({ name: 'propose_revision', arguments: { book: 'sal', ...BOOK_TOOLS[5][1] } }),
    deniedBy('permission_denied', 'com.fullfran.rewrite.revision.propose'));
  await assert.rejects(client.callTool({ name: 'propose_findings', arguments: { book: 'sal', ...BOOK_TOOLS[9][1] } }),
    deniedBy('permission_denied', 'com.fullfran.rewrite.findings.propose'));
  assert.equal(git(book, 'status', '--porcelain'), '');
  assert.equal((await call(client, 'list_claims', { book: 'sal' })).data.total, 0, 'a denied proposal stores nothing');
  revokePermission(data, PACKAGE, READ);
  await assert.rejects(client.callTool({ name: 'list_scenes', arguments: { book: 'sal' } }), deniedBy('permission_denied', READ));
});

test('removing a person\'s book access takes effect on the next MCP call', async () => {
  const { lib } = library();
  const client = await connect(lib, 'user_fran');
  assert.equal((await call(client, 'list_scenes', { book: 'sal' })).isError, false);
  lib.revoke('sal', 'user_fran');
  const denied: any = await client.callTool({ name: 'list_scenes', arguments: { book: 'sal' } });
  assert.equal(denied.isError, true);
  assert.equal(denied.structuredContent.type, 'https://github.com/FullFran/re-write/blob/main/docs/problems.md#unknown-book');
  assert.deepEqual((await call(client, 'list_books', {})).data.books, []);
});

test('an agent for one book gets nothing from another book through any MCP tool, whatever is granted', async () => {
  const { lib, data } = library();
  const other = join(data, 'books', 'otra');
  cli('init', other);
  cli('import', other, join(FIXTURES, 'escena-01.md'));
  lib.grant('otra', 'user_ana');
  for (const permission of REWRITE_PERMISSIONS) grantPermission(data, PACKAGE, permission);
  const head = git(other, 'rev-parse', 'HEAD');
  for (const entry of [null, PACKAGE]) {
    const client = await connectAs(lib, 'user_fran', entry);
    assert.deepEqual((await call(client, 'list_books', {})).data.books.map((b: any) => b.book_id), ['sal']);
    for (const [name, args] of BOOK_TOOLS) {
      const hidden: any = await client.callTool({ name, arguments: { book: 'otra', ...args } });
      const missing: any = await client.callTool({ name, arguments: { book: 'nope', ...args } });
      assert.equal(hidden.isError, true, name);
      assert.deepEqual(hidden.structuredContent, missing.structuredContent, name);
      assert.equal(hidden.structuredContent.type, 'https://github.com/FullFran/re-write/blob/main/docs/problems.md#unknown-book', name);
    }
  }
  assert.equal(git(other, 'rev-parse', 'HEAD'), head);
  assert.equal(git(other, 'status', '--porcelain'), '');
  assert.equal(cli('claims', other).json.claims.length, 0);
});

test('no grant lets an MCP session accept or reject a claim or a proposal', async () => {
  const { lib, data } = library();
  for (const permission of REWRITE_PERMISSIONS) grantPermission(data, PACKAGE, permission);
  assert.throws(() => grantPermission(data, PACKAGE, REVIEW_DECIDE), /cannot be granted/);
  for (const entry of [null, PACKAGE]) {
    const client = await connectAs(lib, 'user_fran', entry);
    const names = (await client.listTools()).tools.map(t => t.name);
    assert.ok(!names.some(name => /accept|approve|reject|decide|review|verdict/.test(name)), names.join(','));
    for (const name of ['review_claim', 'accept_claim', 'review_proposal']) {
      const result: any = await client.callTool({ name, arguments: { book: 'sal' } }).catch(error => ({ isError: true, error }));
      assert.equal(result.isError, true, name);
    }
    const decision = decide({ library: lib, subject: 'user_fran', book: 'sal', door: 'mcp', permission: REVIEW_DECIDE, entry });
    assert.equal(!decision.allow && decision.reason, 'forbidden');
  }
});
