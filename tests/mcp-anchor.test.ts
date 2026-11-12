import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Library } from '../src/application/library.ts';
import { buildMcpServer } from '../src/adapters/mcp.ts';
import { cli, FIXTURES, git, read, tempDir } from './helpers.ts';

const SCENE = 'scenes/escena-01.md';
const QUOTE = 'Elena llevaba once años custodiando el puente de Sal';

/** A book with an extracted claim whose sentence moved, and a connected assistant. */
async function setup() {
  const data = tempDir();
  const book = join(data, 'books', 'sal');
  cli('init', book);
  cli('import', book, join(FIXTURES, 'escena-01.md'));
  cli('extract', book, '--from', join(FIXTURES, 'annotations.json'));
  writeFileSync(join(book, SCENE), read(book, SCENE).replace(`${QUOTE}, y conocía`, 'Nadie sabía nada.\n\nAquella noche, ' + `${QUOTE}, y conocía`));
  git(book, 'commit', '-qam', 'edit');
  const lib = new Library(data);
  lib.grant('sal', 'user_fran');
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await buildMcpServer(lib, 'user_fran').connect(serverSide);
  const client = new Client({ name: 'test', version: '1' });
  await client.connect(clientSide);
  const call = async (name: string, args: object) => {
    const result: any = await client.callTool({ name, arguments: { book: 'sal', ...args } as Record<string, unknown> });
    return { isError: Boolean(result.isError), data: result.isError ? null : JSON.parse(result.content[0].text), structured: result.structuredContent, text: result.content[0]?.text as string };
  };
  const claimId = (await call('list_claims', {})).data.claims.find((c: any) => c.anchor.quote === QUOTE).claim_id;
  return { lib, book, call, claimId };
}

test('propose_anchor stores a proposal and changes no claim; the person accepts it in review', async () => {
  const { lib, book, call, claimId } = await setup();
  const listed = (await call('list_claims', {})).data.claims.find((c: any) => c.claim_id === claimId);
  assert.equal(listed.evidence_status, 'stale');
  assert.equal(listed.anchor_suggestion.quote, QUOTE, 'list_claims shows the suggested passage');
  const claimFile = `.rewrite/claims/${claimId}.json`;
  const before = read(book, claimFile);
  const commits = Number(git(book, 'rev-list', '--count', 'HEAD'));

  const proposed = await call('propose_anchor', { target: 'claim', item_id: claimId, quote: QUOTE, rationale: 'La frase se movió' });
  assert.equal(proposed.isError, false, proposed.text);
  assert.equal(proposed.data.created, true);
  assert.equal(proposed.data.proposal.quote, QUOTE);
  assert.equal(proposed.data.proposal.proposed_by, 'user_fran');
  assert.match(proposed.data.next_step, /You cannot accept or reject anything/);
  assert.deepEqual(proposed.structured, proposed.data);
  assert.equal(read(book, claimFile), before, 'the claim is untouched');
  assert.equal(Number(git(book, 'rev-list', '--count', 'HEAD')), commits + 1);
  assert.equal((await call('propose_anchor', { target: 'claim', item_id: claimId, quote: QUOTE })).data.created, false);

  const pending = (await call('list_claims', {})).data.claims.find((c: any) => c.claim_id === claimId);
  assert.deepEqual(pending.anchor_proposals.map((p: any) => p.anchor_proposal_id), [proposed.data.proposal.anchor_proposal_id]);
  assert.equal(pending.evidence_status, 'stale', 'proposing does not re-anchor');

  lib.open('sal', 'user_fran').reanchorClaim(claimId, { by: 'user_fran', expected: 0, quote: QUOTE, proposal: proposed.data.proposal.anchor_proposal_id });
  assert.equal((await call('list_claims', {})).data.claims.find((c: any) => c.claim_id === claimId).evidence_status, 'valid');
});

test('propose_anchor refuses a quote that is not literal, and a finding position that does not exist', async () => {
  const { call, claimId } = await setup();
  const missing = await call('propose_anchor', { target: 'claim', item_id: claimId, quote: 'Elena llevaba doce años' });
  assert.equal(missing.isError, true);
  assert.match(missing.text, /quote not found/);
  const unknown = await call('propose_anchor', { target: 'finding', item_id: 'F-0000000000', evidence: 0, quote: QUOTE });
  assert.equal(unknown.isError, true);
  assert.match(unknown.text, /unknown finding/);
});
