import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import { crc32, deflateRawSync } from 'node:zlib';
import { git } from './helpers.ts';
import { reviewApi, reviewUpload, startHarness } from './server-helpers.ts';

// A real nested Notion export, generated in memory; no writer's material is used.
function zip(entries: { name: string; content: string | Buffer }[]): Buffer {
  const local: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const { name, content } of entries) {
    const filename = Buffer.from(name);
    const raw = Buffer.from(content);
    const compressed = deflateRawSync(raw);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(0x0800, 6);
    header.writeUInt16LE(8, 8);
    header.writeUInt32LE(crc32(raw), 14);
    header.writeUInt32LE(compressed.length, 18);
    header.writeUInt32LE(raw.length, 22);
    header.writeUInt16LE(filename.length, 26);
    local.push(header, filename, compressed);
    const directory = Buffer.alloc(46);
    directory.writeUInt32LE(0x02014b50, 0);
    directory.writeUInt16LE(20, 4);
    directory.writeUInt16LE(20, 6);
    directory.writeUInt16LE(0x0800, 8);
    directory.writeUInt16LE(8, 10);
    directory.writeUInt32LE(crc32(raw), 16);
    directory.writeUInt32LE(compressed.length, 20);
    directory.writeUInt32LE(raw.length, 24);
    directory.writeUInt16LE(filename.length, 28);
    directory.writeUInt32LE(offset, 42);
    central.push(directory, filename);
    offset += header.length + filename.length + compressed.length;
  }
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(Buffer.concat(central).length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, ...central, end]);
}

const BOOK = 'ensayo-piloto';
const TITLE = 'El sueño de Inés';
const FILE = 'scenes/001-el-sueno.md';
const QUOTE = 'Inés quería abrir el faro para encontrar a su hermana.';
const CONSEQUENCE = 'Al abrir la puerta, la campana despertó al pueblo.';
const KNOWLEDGE = 'Solo Inés sabía que la llave estaba bajo la losa.';
const MARKER = 'La cigüeña del ensayo guarda el manuscrito sintético número setecientos.';
const REPLACEMENT = 'Inés quería cerrar el faro para proteger a su hermana.';
const ORIGINAL = `# El sueño\n\n${QUOTE}\n${CONSEQUENCE}\n${KNOWLEDGE}\n${MARKER}\n`;
const SECOND = '# La señal\n\nLa mañana trajo una señal junto al río.\n';
const SCENES = [FILE, 'scenes/002-la-senal.md', 'scenes/003-pagina-vacia.md'];
const MAPPING = {
  database: 'Capítulos.csv', titleColumn: 'Título', orderColumn: 'Orden',
  filter: { column: 'Libro', value: TITLE },
};

function notionExport(): Buffer {
  const header = 'Título,Orden,Libro';
  const rows = [`La señal,2,${TITLE}`, `El sueño,1,${TITLE}`, `Página vacía,3,${TITLE}`];
  const database = 'Capítulos 11111111111111111111111111111111';
  return zip([{ name: 'Exportación-Part-1.zip', content: zip([
    // The view omits two rows: the importer must choose the _all twin.
    { name: `${database}.csv`, content: `${header}\n${rows[0]}` },
    { name: `${database}_all.csv`, content: [header, ...rows].join('\n') },
    { name: 'El sueño 22222222222222222222222222222222.md', content: ORIGINAL.replace('\n\n', `\n\nOrden: 1\nLibro: ${TITLE}\n\n`) },
    { name: 'La señal 33333333333333333333333333333333.md', content: SECOND },
    { name: 'Página vacía 44444444444444444444444444444444.md', content: '' },
  ]) }]);
}

test('writer pilot: Notion upload → MCP analysis → human review → evaluation', async (t) => {
  const lines: string[] = [];
  t.mock.method(console, 'log', (...args: unknown[]) => lines.push(args.join(' ')));
  t.mock.method(console, 'error', (...args: unknown[]) => lines.push(args.join(' ')));
  t.mock.method(console, 'warn', () => {});
  const h = await startHarness();
  t.after(() => h.close());
  const session = await h.session('user_andres');
  const access = await h.access('user_andres');
  const dir = join(h.data, 'books', BOOK);
  const responses: { response: Response; route: string }[] = [];
  const remember = (response: Response, route: string) => {
    responses.push({ response, route });
    return response;
  };
  const api = async (path: string, route: string, body?: unknown) =>
    remember(await reviewApi(h, path, session, body), `/review/api${route}`);
  const upload = async (action: string, headers: Record<string, string> = {}) =>
    remember(await reviewUpload(h, `/books/${BOOK}/notion/${action}`, session, notionExport(), headers),
      `/review/api/books/:book/notion/${action}`);
  const ok = async (response: Response, status = 200) => {
    const body = await response.json();
    assert.equal(response.status, status, JSON.stringify(body));
    return body;
  };
  let rpcId = 0;
  const rpc = async (method: string, params: object) => {
    const response = remember(await fetch(h.resource, {
      method: 'POST',
      headers: { authorization: `Bearer ${access}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params }),
    }), '/mcp');
    const body = await ok(response);
    assert.equal(body.id, rpcId);
    assert.equal(body.error, undefined, JSON.stringify(body));
    return body.result;
  };
  const tool = async (name: string, args: object = {}) => {
    const result = await rpc('tools/call', { name, arguments: args });
    assert.notEqual(result.isError, true, JSON.stringify(result));
    return JSON.parse(result.content[0].text);
  };
  let findings: any[] = [];

  await t.test('1: signed-in writer creates an empty book', async () => {
    const created = await ok(await api('/books', '/books', { slug: BOOK, title: TITLE }), 201);
    assert.equal(created.book_id, BOOK);
    assert.equal(created.title, TITLE);
    assert.deepEqual((await ok(await api(`/books/${BOOK}/scenes`, '/books/:book/scenes'))).scenes, []);
    assert.equal(git(dir, 'status', '--porcelain'), '');
  });

  await t.test('2: nested Notion inspection, header-mapped preview, import and ordered scenes', async () => {
    const inspected = await ok(await upload('inspect'));
    assert.equal(inspected.databases.length, 2, 'inspection exposes both view and _all database');
    assert.deepEqual(inspected.databases.map((d: any) => d.rowCount).sort(), [1, 3]);
    for (const database of inspected.databases) assert.deepEqual(database.columns, ['Título', 'Orden', 'Libro']);
    assert.equal(inspected.pages.length, 3);
    assert.ok(!JSON.stringify(inspected).includes(MARKER));
    const before = git(dir, 'rev-parse', 'HEAD');
    const mapping = { 'x-notion-mapping': encodeURIComponent(JSON.stringify(MAPPING)) };
    const preview = await ok(await upload('preview', { ...mapping, 'x-dry-run': 'true' }));
    assert.equal(preview.dryRun, true);
    assert.deepEqual(preview.chapters.map((c: any) => c.file), SCENES);
    assert.deepEqual(preview.chapters.map((c: any) => c.status), SCENES.map(() => 'would_import'));
    assert.ok(!JSON.stringify(preview).includes(MARKER));
    assert.equal(existsSync(join(dir, 'scenes')), false);
    assert.equal(git(dir, 'rev-parse', 'HEAD'), before);
    const imported = await ok(await upload('import', mapping));
    assert.deepEqual(imported.imported.map((c: any) => c.file), SCENES);
    assert.deepEqual(imported.refused, []);
    assert.deepEqual(imported.unchanged, []);
    assert.deepEqual((await ok(await api(`/books/${BOOK}/scenes`, '/books/:book/scenes'))).scenes, SCENES);
    for (const [index, text] of [ORIGINAL, SECOND, ''].entries()) {
      assert.equal(readFileSync(join(dir, SCENES[index]), 'utf8'), text);
      assert.equal(git(dir, 'show', `HEAD:${SCENES[index]}`), text.trim());
    }
    assert.notEqual(git(dir, 'rev-parse', 'HEAD'), before);
    assert.equal(git(dir, 'status', '--porcelain'), '');
  });

  await t.test('3: same-person MCP client reads guide and scenes, proposes all questions/kinds and refuses invented evidence', async () => {
    assert.ok((await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'Ophelia', version: '1' } })).serverInfo);
    const guide = (await tool('get_analysis_guide')).guide;
    for (const text of ['¿Qué quiere cada personaje', '¿Qué consecuencias', '¿Qué sabe cada personaje', 'literal', 'fact', 'interpretation', 'alternative']) assert.ok(guide.includes(text), text);
    assert.equal((await tool('read_scene', { book: BOOK, file: FILE })).text, ORIGINAL);
    const candidates = [
      { question: 'motivation', kind: 'fact', statement: 'Inés busca a su hermana.', quote: QUOTE },
      { question: 'consequences', kind: 'interpretation', statement: 'Abrir la puerta alerta a los vecinos.', quote: CONSEQUENCE },
      { question: 'knowledge', kind: 'alternative', statement: 'Inés podría compartir el escondite.', quote: KNOWLEDGE },
    ].map(({ quote, ...finding }) => ({ ...finding, characters: ['Inés'], evidence: [{ file: FILE, quote }] }));
    const proposed = await tool('propose_findings', { book: BOOK, findings: candidates });
    assert.equal(proposed.created.length, 3);
    assert.deepEqual(proposed.existing, []);
    const listed = await tool('list_findings', { book: BOOK });
    assert.equal(listed.total, 3);
    findings = candidates.map(candidate => {
      const finding = listed.findings.find((f: any) => f.statement === candidate.statement);
      assert.ok(finding);
      for (const key of ['question', 'kind', 'statement', 'characters']) assert.deepEqual(finding[key], candidate[key as keyof typeof candidate]);
      assert.equal(finding.author, 'user_andres');
      assert.equal(finding.evidence_status, 'valid');
      assert.equal(finding.evidence[0].quote, candidate.evidence[0].quote);
      return finding;
    });
    const head = git(dir, 'rev-parse', 'HEAD');
    const rejected = await rpc('tools/call', { name: 'propose_findings', arguments: { book: BOOK, findings: [{ ...candidates[0], evidence: [{ file: FILE, quote: 'Inés voló hasta la luna de cristal.' }] }] } });
    assert.equal(rejected.isError, true);
    assert.match(rejected.content[0].text, /Inés voló hasta la luna de cristal/);
    assert.deepEqual(await tool('list_findings', { book: BOOK }), listed);
    assert.equal(git(dir, 'rev-parse', 'HEAD'), head);
    assert.equal(git(dir, 'status', '--porcelain'), '');
  });

  await t.test('4: writer sees and accepts agent revision; git preserves original and stale accept writes nothing', async () => {
    const propose = (replace: string) => tool('propose_revision', { book: BOOK, file: FILE, find: QUOTE, replace, rationale: 'Precisar la intención de Inés.' });
    const first = await propose(REPLACEMENT);
    const second = await propose('Inés quería abandonar el faro para buscar refugio.');
    assert.equal(first.created, true);
    assert.equal(second.created, true);
    assert.equal(readFileSync(join(dir, FILE), 'utf8'), ORIGINAL);
    const scene = await ok(await api(`/books/${BOOK}/scenes/${encodeURIComponent(FILE)}`, '/books/:book/scenes/:file'));
    assert.equal(scene.text, ORIGINAL);
    assert.equal(scene.findings.length, 3);
    const shown = scene.proposals.find((p: any) => p.proposal.proposal_id === first.proposal.proposal_id);
    assert.ok(shown.applicable);
    assert.ok(shown.diff.includes(REPLACEMENT));
    assert.equal(scene.proposals.length, 2);
    const head = git(dir, 'rev-parse', 'HEAD');
    const accepted = await ok(await api(`/books/${BOOK}/proposals/${first.proposal.proposal_id}`, '/books/:book/proposals/:id', { decision: 'accept', note: 'La intención queda más clara.' }));
    assert.equal(accepted.changed, true);
    assert.equal(accepted.proposal.status, 'accepted');
    assert.equal(accepted.proposal.history[0].by, 'user_andres');
    const after = git(dir, 'rev-parse', 'HEAD');
    assert.equal((await tool('get_proposal', { book: BOOK, proposal_id: first.proposal.proposal_id })).proposal.result_commit, after);
    assert.equal(git(dir, 'rev-list', '--count', `${head}..HEAD`), '1');
    assert.equal(git(dir, 'log', '-1', '--format=%s'), `rewrite: accept ${first.proposal.proposal_id}`);
    assert.equal(git(dir, 'show', `${head}:${FILE}`), ORIGINAL.trim());
    const revised = ORIGINAL.replace(QUOTE, REPLACEMENT);
    assert.equal(readFileSync(join(dir, FILE), 'utf8'), revised);
    assert.equal((await ok(await api(`/books/${BOOK}/scenes/${encodeURIComponent(FILE)}`, '/books/:book/scenes/:file'))).text, revised);
    const stale = await ok(await api(`/books/${BOOK}/proposals/${second.proposal.proposal_id}`, '/books/:book/proposals/:id', { decision: 'accept' }), 409);
    assert.match(stale.type, /#stale-evidence$/);
    assert.equal(stale.detail, `${FILE} changed since proposal ${second.proposal.proposal_id} was made; nothing was written`);
    assert.equal(readFileSync(join(dir, FILE), 'utf8'), revised);
    assert.equal(git(dir, 'rev-parse', 'HEAD'), after);
    const pending = await tool('get_proposal', { book: BOOK, proposal_id: second.proposal.proposal_id });
    assert.equal(pending.proposal.status, 'proposed');
    assert.deepEqual(pending.proposal.history, []);
    assert.equal(pending.applicable, false);
  });

  await t.test('5: findings view, useful/noise ratings, changed rating and private evaluation export', async () => {
    const view = await ok(await api(`/books/${BOOK}/findings`, '/books/:book/findings'));
    assert.equal(view.findings.length, 3);
    const text = readFileSync(join(dir, FILE), 'utf8');
    for (const [index, verdict, note] of [[0, 'useful', 'Aclara la intención.'], [1, 'noise', 'La consecuencia ya era evidente.'], [0, 'noise', 'La lectura posterior cambió mi valoración.']] as const) {
      const rated = await ok(await api(`/books/${BOOK}/findings/${findings[index].finding_id}`, '/books/:book/findings/:id', { verdict, note }));
      assert.equal(rated.verdict, verdict);
      assert.equal(rated.note, note);
      assert.equal(rated.by, 'user_andres');
      assert.equal(readFileSync(join(dir, FILE), 'utf8'), text);
    }
    const response = await api(`/books/${BOOK}/export`, '/books/:book/export');
    assert.match(response.headers.get('content-type') ?? '', /application\/json/);
    assert.equal(response.headers.get('content-disposition'), `attachment; filename="findings-${BOOK}.json"`);
    const exported = await ok(response);
    assert.equal(exported.book, BOOK);
    assert.equal(exported.findings.length, 3);
    const changed = exported.findings.find((f: any) => f.finding_id === findings[0].finding_id);
    assert.equal(changed.rating.verdict, 'noise');
    assert.equal(changed.rating.note, 'La lectura posterior cambió mi valoración.');
    assert.equal(changed.rating.history.length, 1);
    assert.equal(changed.rating.history[0].verdict, 'useful');
    assert.equal(changed.rating.history[0].by, 'user_andres');
    assert.equal(exported.findings.find((f: any) => f.finding_id === findings[1].finding_id).rating.verdict, 'noise');
    assert.ok(JSON.stringify(exported).includes(QUOTE));
    for (const prose of [MARKER, ORIGINAL, text, SECOND]) assert.ok(!JSON.stringify(exported).includes(prose));
    assert.equal(git(dir, 'status', '--porcelain'), '');
  });

  await t.test('6: replaced quote is orphaned and the delivered UI warns on the card and scene', async () => {
    const view = await ok(await api(`/books/${BOOK}/findings`, '/books/:book/findings'));
    const finding = view.findings.find((f: any) => f.finding_id === findings[0].finding_id);
    assert.equal(finding.evidence_status, 'orphaned');
    assert.equal(finding.evidence[0].status, 'orphaned');
    assert.equal(finding.evidence[0].quote, QUOTE);
    const scene = await ok(await api(`/books/${BOOK}/scenes/${encodeURIComponent(FILE)}`, '/books/:book/scenes/:file'));
    assert.equal(scene.findings.find((f: any) => f.finding_id === finding.finding_id).evidence_status, 'orphaned');
    assert.ok(!scene.text.includes(QUOTE));

    // Execute the actual HTTP-served UI script with a minimal DOM, not a copied
    // rendering function or a source-string assertion. No browser dependency.
    class Element {
      children: Element[] = [];
      className = '';
      value = '';
      style: Record<string, string> = {};
      listeners: Record<string, (...args: any[]) => any> = {};
      ownText = '';
      classList = { add() {}, remove() {} };
      get textContent(): string { return this.ownText + this.children.map(c => c.textContent).join(''); }
      set textContent(text: string) { this.ownText = text; this.children = []; }
      append(...nodes: Element[]) { this.children.push(...nodes); }
      replaceChildren(...nodes: Element[]) { this.ownText = ''; this.children = nodes; }
      setAttribute() {}
      addEventListener(name: string, listener: (...args: any[]) => any) { this.listeners[name] = listener; }
      scrollIntoView() { rendered?.(); }
    }
    let rendered: (() => void) | undefined;
    const document = {
      getElementById: () => new Element(),
      createElement: () => new Element(),
      createTextNode: (text: string) => { const node = new Element(); node.textContent = text; return node; },
    };
    const response = remember(await fetch(`${h.base}/review/app.js`), '/review/app.js');
    assert.equal(response.status, 200);
    const script = await response.text();
    const ui = runInNewContext(`${script}\n({ narrativeFindingCard, scenesSection });`, {
      document, window: { addEventListener() {}, Clerk: { session: { getToken: async () => session } } },
      fetch: async (path: string) => remember(await fetch(`${h.base}${path}`, { headers: { authorization: `Bearer ${session}` } }), '/review/api/books/:book/scenes/:file'),
    });
    const warnings = (node: Element): Element[] => [
      ...(node.className.includes('badge-stale') ? [node] : []),
      ...node.children.flatMap(warnings),
    ];
    const cardWarning = 'Aviso: una cita de este hallazgo ya no aparece en la escena.';
    const sceneWarning = 'Aviso: la cita ya no está en el texto de la escena.';
    const card = ui.narrativeFindingCard(BOOK, finding, async () => {});
    assert.ok(card.textContent.includes('la cita ya no está en el texto'));
    assert.ok(warnings(card).some((node: Element) => node.textContent === cardWarning));
    assert.ok(!card.textContent.includes('orphaned'));

    // Per-evidence status must drive the warning even if an aggregate is valid.
    for (const status of ['valid', 'stale', 'orphaned']) {
      const variant = { ...finding, evidence_status: 'valid', evidence: [{ ...finding.evidence[0], status }] };
      const renderedCard = ui.narrativeFindingCard(BOOK, variant, async () => {});
      assert.equal(warnings(renderedCard).some((node: Element) => node.textContent.startsWith('Aviso:')), status !== 'valid');
      if (status === 'stale') assert.ok(renderedCard.textContent.includes('La evidencia general está desactualizada'));
    }
    let openQuote: (...args: any[]) => void = () => assert.fail('quote callback not registered');
    const section = ui.scenesSection(BOOK, [FILE], async () => {}, (callback: typeof openQuote) => { openQuote = callback; });
    for (const status of ['valid', 'stale', 'orphaned']) {
      const loaded = new Promise<void>(resolve => { rendered = resolve; });
      openQuote(FILE, QUOTE, finding.evidence[0].anchor, status);
      await loaded;
      const viewer = section.children[2];
      const alerts = viewer.children.filter((node: Element) => node.className.includes('badge-stale'));
      assert.equal(alerts.length, status === 'valid' ? 0 : 1);
      if (status === 'orphaned') assert.equal(alerts[0].textContent, sceneWarning);
      if (status === 'stale') assert.ok(alerts[0].textContent.includes('El texto alrededor de la cita cambió'));
    }
  });

  await t.test('7: every request has a correlated metadata-only route-template log', async () => {
    const records = lines.map(line => JSON.parse(line));
    const http = records.filter(record => record.event === 'http.request');
    assert.equal(http.length, responses.length);
    assert.equal(records.filter(record => record.event === 'mcp.call').length, rpcId);
    const ids = responses.map(({ response, route }) => {
      const id = response.headers.get('x-request-id');
      assert.match(id ?? '', /^[0-9a-f-]{36}$/);
      const matches = http.filter(record => record.request_id === id);
      assert.equal(matches.length, 1);
      assert.equal(matches[0].status, response.status);
      assert.equal(matches[0].route, route);
      return id;
    });
    assert.equal(new Set(ids).size, responses.length);
    for (const record of records) {
      assert.ok(ids.includes(record.request_id));
      assert.ok(Number.isFinite(record.duration_ms) && record.duration_ms >= 0);
      assert.ok(Number.isFinite(Date.parse(record.timestamp)));
    }
    const output = lines.join('\n');
    for (const marker of [MARKER, QUOTE, CONSEQUENCE, KNOWLEDGE, REPLACEMENT, TITLE, BOOK, FILE, session, access]) assert.ok(!output.includes(marker), `log leaked ${marker}`);
  });
});
