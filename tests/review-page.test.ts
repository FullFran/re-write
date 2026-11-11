import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import { REVIEW_JS, REVIEW_CSS } from '../src/adapters/review-page.ts';

// Minimal DOM adapter: execute the shipped script, not a second rendering implementation.
class Element {
  tag: string;
  children: Element[] = [];
  ownText = '';
  className = '';
  value = '';
  disabled = false;
  style = {};
  id = '';
  classList = { add() {}, remove() {} };
  attrs: Record<string, string> = {};
  events: Record<string, Function> = {};
  constructor(tag: string) { this.tag = tag; }
  set textContent(text: string) { this.ownText = text; this.children = []; }
  get textContent(): string { return this.ownText + this.children.map(c => c.textContent).join(''); }
  append(...nodes: Element[]) { this.children.push(...nodes); }
  prepend(node: Element) { this.children.unshift(node); }
  replaceChildren(...nodes: Element[]) { this.ownText = ''; this.children = [...nodes]; }
  setAttribute(key: string, value: string) { this.attrs[key] = value; }
  addEventListener(event: string, fn: Function) { this.events[event] = fn; }
  scrollIntoView() {}
  focus() {}
}
function nodes(root: Element, tag: string): Element[] {
  return [...(root.tag === tag ? [root] : []), ...root.children.flatMap(c => nodes(c, tag))];
}
function page(queue: any = {}, post: Function = () => {}) {
  const app = new Element('main');
  const context = runInNewContext(REVIEW_JS + '\n({ proposalCard, claimCard, narrativeFindingCard, renderApp })', {
    document: { getElementById: (id: string) => id === 'app' ? app : nodes(app, 'article').find(n => n.id === id), createElement: (t: string) => new Element(t), createTextNode: (t: string) => Object.assign(new Element('#text'), { textContent: t }) },
    window: { addEventListener() {}, Clerk: { session: { getToken: async () => 'session' } } },
    fetch: async (url: string, options: any) => {
      if (options.method === 'POST') post(JSON.parse(options.body));
      return { ok: true, json: async () => url.endsWith('/books') ? { books: [{ book_id: 'sal', title: 'Sal' }] } : url.includes('/scenes/') ? { file: 'scenes/a.md', text: 'scene', proposals: queue.proposals, findings: [] } : queue };
    },
  });
  return { ...context, app };
}
const diff = '--- scene @ base\n+++ scene (proposed)\n@@ -1,2 +1,2 @@\n-old <script>\n+new <img>\n context\n';
const proposal = (status = 'proposed', applicable = true) => ({ proposal: { proposal_id: 'P-1', rationale: 'Reason', status, result_commit: status === 'accepted' ? 'abcdef123456' : undefined }, diff, applicable });
const claim = (editorial_status = 'proposed', epistemic_kind = 'narrated_fact', evidence_status = 'valid') => ({ claim_id: 'C-1', statement: 'Statement', anchor: { quote: 'Quote' }, editorial_status, epistemic_kind, evidence_status });

test('visual diff marks removals and additions while preserving the exact unified text', () => {
  const card = page().proposalCard('sal', proposal(), async () => {});
  assert.equal(nodes(card, 'del')[0]?.textContent, 'old <script>');
  assert.equal(nodes(card, 'ins')[0]?.textContent, 'new <img>');
  assert.ok(card.textContent.includes('Eliminado') && card.textContent.includes('Añadido'));
  assert.equal(nodes(card, 'details')[0].textContent, 'Ver diff unificado (texto)' + diff);
  assert.equal(nodes(card, 'pre').at(-1)?.textContent, diff);
  assert.equal(nodes(card, 'script').length, 0);
  assert.equal(nodes(card, 'img').length, 0);
  assert.match(REVIEW_CSS, /\.diff-removed/);
  assert.match(REVIEW_CSS, /\.diff-added/);
});

test('all proposal and claim states have Spanish badges, with accepted version evidence', () => {
  const ui = page();
  for (const [state, label] of [['proposed', 'Pendiente'], ['accepted', 'Aceptada'], ['rejected', 'Rechazada']]) {
    for (const card of [ui.proposalCard('sal', proposal(state), async () => {}), ui.claimCard('sal', claim(state), async () => {})]) {
      assert.ok(nodes(card, 'span').some(n => n.className.includes('badge') && n.textContent === label));
      assert.ok(!card.textContent.includes('Estado: ' + state));
    }
  }
  const accepted = ui.proposalCard('sal', proposal('accepted'), async () => {});
  assert.match(accepted.textContent, /versión abcdef1234/);
  const stale = ui.proposalCard('sal', proposal('proposed', false), async () => {});
  assert.match(stale.textContent, /No aplicable: la escena ha cambiado/);
  assert.ok(!nodes(stale, 'button').some(n => n.textContent === 'Aceptar cambio'));
  assert.ok(nodes(stale, 'button').some(n => n.textContent === 'Rechazar'));
});

test('decisions keep the acted-on proposal visible with its new badge after reload', async () => {
  for (const decision of ['accept', 'reject']) {
    const item = proposal();
    const queue = { scenes: [], proposals: [item], claims: [], canon: [], findings: [] };
    const ui = page(queue, () => { item.proposal.status = decision === 'accept' ? 'accepted' : 'rejected'; });
    await ui.renderApp('sal');
    const pending = nodes(ui.app, 'section').find(n => nodes(n, 'h2').some(h => h.textContent === 'Cambios propuestos'))!;
    const action = nodes(pending, 'button').find(n => n.textContent === (decision === 'accept' ? 'Aceptar cambio' : 'Rechazar'))!;
    await action.events.click();
    const refreshed = nodes(ui.app, 'section').find(n => nodes(n, 'h2').some(h => h.textContent === 'Cambios propuestos'))!;
    assert.ok(nodes(refreshed, 'span').some(n => n.textContent === (decision === 'accept' ? 'Aceptada' : 'Rechazada')));
  }
});

test('Canon stays distinct from text history and explains excluded and rejected claims', async () => {
  const rumor = { ...claim('accepted', 'rumor'), claim_id: 'rumor', statement: 'Rumor accepted' };
  const stale = { ...claim('accepted', 'narrated_fact', 'stale'), claim_id: 'stale', statement: 'Stale accepted' };
  const rejected = { ...claim('rejected'), claim_id: 'rejected', statement: 'Rejected statement' };
  const valid = { ...claim('accepted'), claim_id: 'valid', statement: 'Canonical statement' };
  const ui = page({ scenes: [], proposals: [proposal('accepted')], claims: [rumor, stale, rejected, valid], canon: [valid], findings: [] });
  await ui.renderApp('sal');
  const section = (title: string) => nodes(ui.app, 'section').find(n => nodes(n, 'h2').some(h => h.textContent === title))!;
  assert.match(section('Canon').textContent, /hechos narrados.*evidencia válida/);
  assert.ok(!section('Canon').textContent.includes('Rumor accepted'));
  assert.match(section('Afirmaciones fuera del Canon').textContent, /no es un hecho narrado/);
  assert.match(section('Afirmaciones fuera del Canon').textContent, /evidencia.*desactualizada/);
  assert.match(section('Afirmaciones rechazadas').textContent, /Rejected statement/);
  assert.match(section('Historial de cambios del manuscrito').textContent, /no convierte.*Canon/);
});

test('note counter reports the limit without cutting input and blocks over-limit submissions', async () => {
  let posts = 0;
  const ui = page({}, () => posts++);
  const card = ui.narrativeFindingCard('sal', { finding_id: 'F-1', evidence: [], author: 'a', statement: 's' }, async () => {});
  const input = nodes(card, 'input')[0];
  assert.match(card.textContent, /0 \/ 2000 caracteres/);
  input.value = 'x'.repeat(2001);
  input.events.input();
  assert.match(card.textContent, /2001 \/ 2000 caracteres/);
  const button = nodes(card, 'button')[0];
  await button.events.click();
  assert.equal(posts, 0);
  assert.equal(input.value.length, 2001);
  input.value = 'x'.repeat(2000);
  input.events.input();
  await button.events.click();
  assert.equal(posts, 1);
});


test('claim decisions stay visible and refresh Canon without duplicate card IDs', async () => {
  for (const decision of ['accept', 'reject']) {
    const item = claim();
    const queue = { scenes: [], proposals: [], claims: [item], canon: [] as any[], findings: [] };
    const ui = page(queue, () => {
      item.editorial_status = decision === 'accept' ? 'accepted' : 'rejected';
      if (decision === 'accept') queue.canon = [item];
    });
    await ui.renderApp('sal');
    const action = nodes(ui.app, 'button').find(n => n.textContent === (decision === 'accept' ? 'Aceptar' : 'Rechazar'))!;
    await action.events.click();
    const pending = nodes(ui.app, 'section').find(n => nodes(n, 'h2').some(h => h.textContent === 'Afirmaciones por revisar'))!;
    assert.ok(nodes(pending, 'span').some(n => n.textContent === (decision === 'accept' ? 'Aceptada' : 'Rechazada')));
    const ids = nodes(ui.app, 'article').map(n => n.id);
    assert.equal(new Set(ids).size, ids.length);
  }
});

test('scene decisions reopen the scene with the new state and no accept action', async () => {
  const item = proposal();
  const ui = page({ scenes: ['scenes/a.md'], proposals: [item], claims: [], canon: [], findings: [] }, () => { item.proposal.status = 'accepted'; });
  await ui.renderApp('sal', 'scenes/a.md');
  const viewer = () => nodes(ui.app, 'div').find(n => n.className === 'scene-viewer')!;
  const action = nodes(viewer(), 'button').find(n => n.textContent === 'Aceptar cambio')!;
  await action.events.click();
  assert.match(viewer().textContent, /Aceptada/);
  assert.ok(!nodes(viewer(), 'button').some(n => n.textContent === 'Aceptar cambio'));
  assert.ok(!nodes(ui.app, 'p').some(n => n.attrs.role === 'alert'));
});

test('"Crear otro libro" opens and closes its form as many times as it is clicked', async () => {
  const ui = page({ scenes: [], proposals: [], claims: [], canon: [], findings: [] });
  await ui.renderApp('sal');
  const toggle = nodes(ui.app, 'button').find(n => n.textContent === 'Crear otro libro')!;
  const form = nodes(ui.app, 'section').find(n => nodes(n, 'h2').some(h => h.textContent === 'Crear un nuevo libro'))! as any;
  assert.equal(form.style.display, 'none');
  for (const [display, expanded] of [['block', 'true'], ['none', 'false'], ['block', 'true']]) {
    await toggle.events.click();
    assert.equal(form.style.display, display);
    assert.equal(toggle.attrs['aria-expanded'], expanded);
    assert.equal(toggle.disabled, false);
  }
});
