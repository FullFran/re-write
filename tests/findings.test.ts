import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Library } from '../src/application/library.ts';
import { buildMcpServer } from '../src/adapters/mcp.ts';
import { cli, FIXTURES, git, tempDir } from './helpers.ts';

const SCENE = 'scenes/escena-01.md';
const QUOTE_1 = 'Elena llevaba once años custodiando el puente de Sal';
const QUOTE_2 = '—No fue Bruno —dijo Elena—. La llave está bajo la losa del altar.';

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

async function call(client: Client, name: string, args: object): Promise<{ isError: boolean; data: any; text: string; structuredContent?: any }> {
  const result: any = await client.callTool({ name, arguments: args as Record<string, unknown> });
  const text = result.content?.[0]?.text ?? '';
  let data: any = null;
  try {
    data = JSON.parse(text);
  } catch {
    // Errors can be plain text
  }
  return { isError: Boolean(result.isError), data, text, structuredContent: result.structuredContent };
}

test('get_analysis_guide returns the narrative analysis procedure in Spanish', async () => {
  const { lib } = library();
  const client = await connect(lib, 'user_fran');

  const res = await call(client, 'get_analysis_guide', {});
  assert.equal(res.isError, false);
  assert.ok(res.data?.guide, 'guide text is present');
  const guide: string = res.data.guide;

  // Three core questions
  assert.ok(guide.includes('¿Qué quiere cada personaje y por qué actúa de esa manera?'));
  assert.ok(guide.includes('¿Qué consecuencias tienen sus decisiones y qué contradicciones podrían existir?'));
  assert.ok(guide.includes('¿Qué sabe cada personaje, qué sabe el lector y qué información falta para entender la historia?'));

  // Literal evidence rule
  assert.ok(guide.includes('literal'));

  // Three kinds
  assert.ok(guide.includes('fact'));
  assert.ok(guide.includes('interpretation'));
  assert.ok(guide.includes('alternative'));

  // Uncertainty & limits
  assert.ok(guide.includes('incertidumbre') || guide.includes('ambigüedad'));
  assert.ok(guide.includes('estructura') || guide.includes('fórmulas'));
  assert.ok(guide.includes('puntajes') || guide.includes('calidad'));
  assert.ok(guide.includes('reescritura') || guide.includes('diagnóstico'));
  assert.ok(guide.includes('no confiables') || guide.includes('untrusted'));
});

test('propose_findings stores findings with literal quotes and list_findings lists them', async () => {
  const { lib } = library();
  const client = await connect(lib, 'user_fran');

  const candidates = [
    {
      question: 'motivation',
      kind: 'fact',
      statement: 'Elena custodia el puente de Sal desde hace once años.',
      characters: ['Elena'],
      evidence: [{ file: SCENE, quote: QUOTE_1 }],
    },
    {
      question: 'knowledge',
      kind: 'interpretation',
      statement: 'Elena afirma conocer el paradero de la llave sin revelar la fuente.',
      characters: ['Elena'],
      evidence: [{ file: SCENE, quote: QUOTE_2 }],
    },
  ];

  const proposed = await call(client, 'propose_findings', { book: 'sal', findings: candidates });
  assert.equal(proposed.isError, false);
  assert.equal(proposed.data.created.length, 2);
  assert.equal(proposed.data.existing.length, 0);

  const listed = await call(client, 'list_findings', { book: 'sal' });
  assert.equal(listed.isError, false);
  assert.equal(listed.data.findings.length, 2);

  const first = listed.data.findings.find((f: any) => f.statement === candidates[0].statement);
  assert.ok(first, 'finding is present');
  assert.ok(first.finding_id.startsWith('F-'));
  assert.equal(first.status, 'pending');
  assert.equal(first.author, 'user_fran');
  assert.equal(first.evidence_status, 'valid');
  assert.equal(first.evidence[0].status, 'valid');
  assert.equal(first.evidence[0].file, SCENE);
  assert.equal(first.evidence[0].quote, QUOTE_1);
  assert.equal(first.verdict, undefined, 'leaves room for verdict');
});

test('non-literal quote is rejected with a product error naming the quote and nothing is stored', async () => {
  const { lib } = library();
  const client = await connect(lib, 'user_fran');

  const FAKE_QUOTE = 'Elena voló por encima del puente con alas doradas.';
  const candidates = [
    {
      question: 'consequences',
      kind: 'alternative',
      statement: 'Elena podría volar si tuviera alas mágicas.',
      evidence: [{ file: SCENE, quote: FAKE_QUOTE }],
    },
  ];

  const proposed = await call(client, 'propose_findings', { book: 'sal', findings: candidates });
  assert.equal(proposed.isError, true);
  assert.ok(proposed.text.includes(FAKE_QUOTE), 'error message must name the offending quote');

  const listed = await call(client, 'list_findings', { book: 'sal' });
  assert.equal(listed.isError, false);
  assert.equal(listed.data.findings.length, 0, 'nothing must be stored when a quote is rejected');
});

test('retry of the same propose_findings call stores once', async () => {
  const { lib } = library();
  const client = await connect(lib, 'user_fran');

  const candidates = [
    {
      question: 'motivation',
      kind: 'fact',
      statement: 'Elena custodia el puente de Sal desde hace once años.',
      characters: ['Elena'],
      evidence: [{ file: SCENE, quote: QUOTE_1 }],
    },
  ];

  const first = await call(client, 'propose_findings', { book: 'sal', findings: candidates });
  assert.equal(first.isError, false);
  assert.equal(first.data.created.length, 1);
  assert.equal(first.data.existing.length, 0);

  const second = await call(client, 'propose_findings', { book: 'sal', findings: candidates });
  assert.equal(second.isError, false);
  assert.equal(second.data.created.length, 0);
  assert.equal(second.data.existing.length, 1);
  assert.equal(second.data.existing[0], first.data.created[0]);

  const listed = await call(client, 'list_findings', { book: 'sal' });
  assert.equal(listed.isError, false);
  assert.equal(listed.data.findings.length, 1, 'only one finding stored across retries');
});

test('subject without access to the book gets the same refusal as for a missing book', async () => {
  const { lib } = library();
  const client = await connect(lib, 'user_stranger');

  const candidates = [
    {
      question: 'motivation',
      kind: 'fact',
      statement: 'Elena custodia el puente.',
      evidence: [{ file: SCENE, quote: QUOTE_1 }],
    },
  ];

  const propHidden = await call(client, 'propose_findings', { book: 'sal', findings: candidates });
  const propMissing = await call(client, 'propose_findings', { book: 'missing-book', findings: candidates });
  assert.equal(propHidden.isError, true);
  assert.deepEqual(propHidden.structuredContent, propMissing.structuredContent);
  assert.equal(propHidden.structuredContent.type, 'https://github.com/FullFran/re-write/blob/main/docs/problems.md#unknown-book');

  const listHidden = await call(client, 'list_findings', { book: 'sal' });
  const listMissing = await call(client, 'list_findings', { book: 'missing-book' });
  assert.equal(listHidden.isError, true);
  assert.deepEqual(listHidden.structuredContent, listMissing.structuredContent);
  assert.equal(listHidden.structuredContent.type, 'https://github.com/FullFran/re-write/blob/main/docs/problems.md#unknown-book');
});

test('evidence turns stale after the scene changes', async () => {
  const { lib, book } = library();
  const client = await connect(lib, 'user_fran');

  const candidates = [
    {
      question: 'motivation',
      kind: 'fact',
      statement: 'Elena custodia el puente de Sal desde hace once años.',
      characters: ['Elena'],
      evidence: [{ file: SCENE, quote: QUOTE_1 }],
    },
  ];

  const proposed = await call(client, 'propose_findings', { book: 'sal', findings: candidates });
  assert.equal(proposed.isError, false);

  const before = await call(client, 'list_findings', { book: 'sal' });
  assert.equal(before.data.findings[0].evidence_status, 'valid');

  // Change scene text around the quote
  const scenePath = join(book, SCENE);
  const originalText = readFileSync(scenePath, 'utf8');
  const modifiedText = originalText.replace(
    'y conocía cada grieta de sus piedras.',
    'y miraba las aguas turbias pasar bajo los arcos.',
  );
  writeFileSync(scenePath, modifiedText);
  git(book, 'commit', '-am', 'edit scene 1 context');

  const after = await call(client, 'list_findings', { book: 'sal' });
  assert.equal(after.isError, false);
  assert.equal(after.data.findings[0].evidence_status, 'stale');
  assert.equal(after.data.findings[0].evidence[0].status, 'stale');
});
