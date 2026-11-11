import assert from 'node:assert/strict';
import { join } from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';
import { runInNewContext } from 'node:vm';
import { cli, FIXTURES, read } from './helpers.ts';
import { proposeRevision, reviewApi, startHarness, type Harness } from './server-helpers.ts';

// The review page's way back from a decision (#98): undo on the card, revert of a text change
// through an inverse proposal, "Volver a revisar" in Historial, and the stale-tab refusal. The
// page script the server serves runs against a minimal DOM and the real server.

const BOOK = 'sal';
const SCENE = 'scenes/escena-01.md';
const FIND = 'Fuera empezaba a llover';
const REPLACE = 'Fuera seguía lloviendo';
const STALE = 'Esta decisión cambió en otra pestaña. Recarga para ver el estado actual.';
const PENDING = 'Cambios propuestos';
const HISTORY = 'Historial de cambios del manuscrito';

let h: Harness;
let session: string;

beforeEach(async (t) => {
  t.mock.method(console, 'log', () => {});
  t.mock.method(console, 'warn', () => {});
  t.mock.method(console, 'error', () => {});
  h = await startHarness();
  session = await h.session();
});

afterEach(() => h?.close());

interface Call { path: string; method: string; status: number; body: any }

async function openPage() {
  class Element {
    tagName: string;
    children: Element[] = [];
    parent: Element | null = null;
    ownText = '';
    className = '';
    id = '';
    type = '';
    href = '';
    value = '';
    defaultValue = '';
    files: unknown[] | null = null;
    hidden = false;
    disabled = false;
    tabIndex = 0;
    style: Record<string, string> = {};
    attrs: Record<string, string> = {};
    events: Record<string, (...args: any[]) => any> = {};
    classList = { add() {}, remove() {} };
    constructor(tag: string) { this.tagName = tag.toUpperCase(); }
    get textContent(): string { return this.ownText + this.children.map((c) => c.textContent).join(''); }
    set textContent(text: string) { this.replaceChildren(); this.ownText = text; }
    private adopt(nodes: Element[]) { for (const node of nodes) { node.remove(); node.parent = this; } }
    append(...nodes: Element[]) { this.adopt(nodes); this.children.push(...nodes); }
    prepend(...nodes: Element[]) { this.adopt(nodes); this.children.unshift(...nodes); }
    after(...nodes: Element[]) {
      const parent = this.parent!;
      for (const node of nodes) node.remove();
      const at = parent.children.indexOf(this) + 1;
      for (const node of nodes) node.parent = parent;
      parent.children.splice(at, 0, ...nodes);
    }
    replaceChildren(...nodes: Element[]) {
      for (const child of this.children) child.parent = null;
      this.children = [];
      this.ownText = '';
      this.append(...nodes);
    }
    remove() {
      if (this.parent) this.parent.children = this.parent.children.filter((c) => c !== this);
      this.parent = null;
    }
    setAttribute(key: string, value: string) { this.attrs[key] = value; }
    getAttribute(key: string) { return this.attrs[key] ?? null; }
    removeAttribute(key: string) { delete this.attrs[key]; }
    addEventListener(name: string, listener: (...args: any[]) => any) { this.events[name] = listener; }
    getElementsByTagName(tag: string): Element[] { return all(this, (n) => n !== this && n.tagName === tag.toUpperCase()); }
    closest(tag: string): Element | null {
      for (let node: Element | null = this; node; node = node.parent) if (node.tagName === tag.toUpperCase()) return node;
      return null;
    }
    getBoundingClientRect() { return { top: 0 }; }
    scrollIntoView() {}
    focus() { document.activeElement = this; }
  }
  function all(root: Element, match: (node: Element) => boolean): Element[] {
    return [...(match(root) ? [root] : []), ...root.children.flatMap((c) => all(c, match))];
  }

  const app = new Element('main');
  const body = new Element('body');
  const timers: Array<{ id: number; run: () => unknown; delay: number }> = [];
  const calls: Call[] = [];
  const listeners: Record<string, (...args: any[]) => any> = {};
  let nextTimer = 0;
  const document = {
    hidden: false,
    activeElement: body as Element,
    getElementById: (id: string) => id === 'app' ? app : id === 'user' ? new Element('div') : all(app, (n) => n.id === id)[0] ?? null,
    createElement: (tag: string) => new Element(tag),
    createTextNode: (text: string) => Object.assign(new Element('#text'), { ownText: text }),
    addEventListener: (name: string, listener: (...args: any[]) => any) => { listeners[name] = listener; },
    // Only the open-dialog selector is asked for; it finds what the page itself put there.
    querySelector: () => all(app, (n) => n.attrs.role === 'dialog' || n.attrs['aria-modal'] === 'true' || (n.tagName === 'DIALOG' && 'open' in n.attrs))[0] ?? null,
  };
  runInNewContext(await (await fetch(`${h.base}/review/app.js`)).text(), {
    document,
    window: {
      scrollY: 0,
      scrollTo() {},
      scrollBy() {},
      addEventListener: (name: string, listener: (...args: any[]) => any) => { listeners[name] = listener; },
      Clerk: { load: async () => {}, isSignedIn: true, mountUserButton() {}, session: { getToken: async () => session } },
    },
    fetch: async (path: string, init: RequestInit = {}) => {
      const response = await fetch(`${h.base}${path}`, init);
      calls.push({ path, method: init.method ?? 'GET', status: response.status, body: init.body ? JSON.parse(String(init.body)) : undefined });
      return response;
    },
    setTimeout: (run: () => unknown, delay: number) => { timers.push({ id: ++nextTimer, run, delay }); return nextTimer; },
    clearTimeout: (id: number) => { const at = timers.findIndex((t) => t.id === id); if (at !== -1) timers.splice(at, 1); },
  });
  await listeners.load();

  const section = (title: string): Element => {
    const found = all(app, (n) => n.tagName === 'SECTION' && all(n, (c) => c.tagName === 'H2')[0]?.textContent === title)[0];
    assert.ok(found, `section "${title}" is rendered`);
    return found;
  };
  const buttons = (root: Element, label: string) => all(root, (n) => n.tagName === 'BUTTON' && n.textContent === label);
  const click = async (root: Element, label: string) => {
    const [found, ...more] = buttons(root, label);
    assert.ok(found, `a "${label}" button is shown`);
    assert.equal(more.length, 0, `one "${label}" button`);
    await found.events.click({ preventDefault() {} });
  };
  return {
    app, document, calls, all, section, buttons, click,
    cardWith: (root: Element, text: string) => all(root, (n) => n.tagName === 'ARTICLE' && n.textContent.includes(text))[0],
    alerts: () => all(app, (n) => n.attrs.role === 'alert'),
    dialogs: () => all(app, (n) => n.attrs.role === 'dialog'),
    posts: () => calls.filter((c) => c.method === 'POST'),
    async tick() {
      const poll = timers.filter((t) => t.delay >= 1000)[0];
      assert.ok(poll, 'a poll is scheduled');
      timers.splice(timers.indexOf(poll), 1);
      await poll.run();
    },
  };
}

async function proposal(id: string) {
  const queue = await (await reviewApi(h, `/books/${BOOK}`, session)).json();
  return queue.proposals.find((p: any) => p.proposal.proposal_id === id).proposal;
}

test('rechazar -> deshacer -> aceptar: the card keeps "Decisión guardada · Deshacer" and decides again', async () => {
  const id = proposeRevision(h.bookDir, SCENE, FIND, REPLACE);
  const before = read(h.bookDir, SCENE);
  const page = await openPage();

  await page.click(page.cardWith(page.section(PENDING), REPLACE), 'Rechazar');
  assert.deepEqual(page.posts().at(-1)!.body, { decision: 'reject', expected: 0 }, 'the decision carries the history length the tab saw');
  const decided = page.cardWith(page.section(PENDING), REPLACE);
  assert.ok(decided.textContent.includes('Rechazada'));
  assert.ok(decided.textContent.includes('Decisión guardada'), 'the same card says the decision is saved');
  assert.equal(page.buttons(decided, 'Aceptar cambio').length, 0);

  await page.click(decided, 'Deshacer');
  assert.equal(page.posts().at(-1)!.path, `/review/api/books/${BOOK}/proposals/${id}/reopen`);
  assert.deepEqual(page.posts().at(-1)!.body, { expected: 1 });
  assert.equal((await proposal(id)).status, 'proposed');
  assert.equal(read(h.bookDir, SCENE), before, 'reopening never touches the text');
  const reopened = page.cardWith(page.section(PENDING), REPLACE);
  assert.ok(reopened.textContent.includes('Pendiente'));
  assert.ok(!reopened.textContent.includes('Decisión guardada'));
  assert.equal(page.document.activeElement, reopened, 'focus stays on the card');

  await page.click(reopened, 'Aceptar cambio');
  assert.deepEqual(page.posts().at(-1)!.body, { decision: 'accept', expected: 2 });
  assert.equal((await proposal(id)).status, 'accepted');
  assert.ok(read(h.bookDir, SCENE).includes(REPLACE));
  assert.deepEqual(page.alerts(), []);
});

test('a tab that saw an older state cannot decide: plain Spanish 409 with a reload action', async () => {
  const id = proposeRevision(h.bookDir, SCENE, FIND, REPLACE);
  const page = await openPage();
  // Another tab rejects and reopens: the status is "proposed" again, the history is longer.
  await reviewApi(h, `/books/${BOOK}/proposals/${id}`, session, { decision: 'reject' });
  await reviewApi(h, `/books/${BOOK}/proposals/${id}/reopen`, session, { expected: 1 });
  const before = read(h.bookDir, SCENE);

  await page.click(page.cardWith(page.section(PENDING), REPLACE), 'Aceptar cambio');
  assert.equal(page.calls.at(-1)!.status, 409);
  assert.equal(read(h.bookDir, SCENE), before, 'nothing was applied');
  assert.equal((await proposal(id)).history.length, 2, 'nothing was recorded');
  const [alert] = page.alerts();
  assert.ok(alert, 'an error is shown');
  assert.ok(alert.textContent.startsWith(STALE));

  await page.click(alert, 'Recargar');
  assert.deepEqual(page.alerts(), [], 'reloading clears the error');
  const card = page.cardWith(page.section(PENDING), REPLACE);
  assert.ok(card.textContent.includes('Reabierta por user_fran'), 'the reloaded card shows the current history');
  await page.click(card, 'Aceptar cambio');
  assert.deepEqual(page.posts().at(-1)!.body, { decision: 'accept', expected: 2 });
  assert.equal((await proposal(id)).status, 'accepted');
});

test('aceptar -> revertir -> aceptar la inversa restores the bytes, after a confirmation that a refresh never closes', async () => {
  const before = read(h.bookDir, SCENE);
  const id = proposeRevision(h.bookDir, SCENE, FIND, REPLACE);
  const page = await openPage();
  await page.click(page.cardWith(page.section(PENDING), REPLACE), 'Aceptar cambio');
  const accepted = page.cardWith(page.section(PENDING), REPLACE);
  assert.ok(accepted.textContent.includes('Decisión guardada'));
  assert.equal(page.buttons(accepted, 'Deshacer decisión editorial').length, 0, 'an applied change is not "undone" like an editorial decision');
  assert.deepEqual(page.dialogs(), [], 'no dialog until one is asked for');

  await page.click(accepted, 'Deshacer');
  const [confirm] = page.dialogs();
  assert.ok(confirm, 'undoing an applied change asks first');
  assert.ok(confirm.textContent.includes('Revertir cambio de texto'));
  assert.ok(confirm.textContent.includes('propuesta inversa'));
  assert.ok(confirm.textContent.includes('El texto no cambia hasta que'));
  assert.equal(page.posts().length, 1, 'opening the confirmation writes nothing');

  // A change made elsewhere arrives while the confirmation is open: it is not re-rendered away.
  proposeRevision(h.bookDir, SCENE, 'El guardia no preguntó', 'El guardia calló');
  await page.tick();
  assert.deepEqual(page.dialogs(), [confirm]);
  assert.equal(page.cardWith(page.section(PENDING), 'El guardia calló'), undefined);

  await page.click(confirm, 'Cancelar');
  assert.deepEqual(page.dialogs(), [], 'cancelling leaves nothing behind');
  assert.equal(page.posts().length, 1);
  assert.equal((await proposal(id)).history.length, 1);

  const again = page.cardWith(page.section(PENDING), REPLACE);
  assert.equal(page.buttons(again, 'Deshacer')[0].attrs['aria-label'], 'Deshacer: revertir cambio de texto', 'the undo names what it does');
  await page.click(again, 'Deshacer');
  await page.click(page.dialogs()[0], 'Crear propuesta inversa');
  assert.equal(page.posts().at(-1)!.path, `/review/api/books/${BOOK}/proposals/${id}/revert`);
  assert.deepEqual(page.posts().at(-1)!.body, { expected: 1 });
  assert.deepEqual(page.dialogs(), []);
  assert.ok(read(h.bookDir, SCENE).includes(REPLACE), 'the revert alone does not change the text');
  const inverse = page.cardWith(page.section(PENDING), 'Revierte el cambio aceptado');
  assert.ok(inverse, 'the inverse proposal waits in Cambios propuestos');
  assert.ok(inverse.textContent.includes('Pendiente'));
  assert.equal(page.document.activeElement, inverse, 'focus moves to the proposal to accept');

  await page.click(inverse, 'Aceptar cambio');
  assert.equal(read(h.bookDir, SCENE), before, 'the scene is back byte for byte');

  const original = page.cardWith(page.section(HISTORY), 'Reversión pedida por user_fran');
  assert.ok(original, 'Historial shows the revert on the original change');
  await page.click(original, 'Volver a proponer');
  assert.equal(page.posts().at(-1)!.path, `/review/api/books/${BOOK}/proposals/${id}/repropose`);
  const proposedAgain = page.cardWith(page.section(PENDING), 'Vuelve a proponer');
  assert.ok(proposedAgain && proposedAgain.textContent.includes(REPLACE), 'the change is proposed again against the current text');
  assert.deepEqual(page.alerts(), []);
});

test('Historial offers "Volver a revisar" after a reload and lists accept -> revert -> new decision with actor, date and links', async () => {
  const rejected = proposeRevision(h.bookDir, SCENE, 'El guardia no preguntó', 'El guardia calló');
  await reviewApi(h, `/books/${BOOK}/proposals/${rejected}`, session, { decision: 'reject' });
  const id = proposeRevision(h.bookDir, SCENE, FIND, REPLACE);
  await reviewApi(h, `/books/${BOOK}/proposals/${id}`, session, { decision: 'accept' });
  const inverse = (await (await reviewApi(h, `/books/${BOOK}/proposals/${id}/revert`, session, { expected: 1 })).json()).proposal.proposal_id;
  await reviewApi(h, `/books/${BOOK}/proposals/${inverse}`, session, { decision: 'accept', expected: 0 });

  // A fresh page: nothing remembered in the browser, everything comes from the server.
  const page = await openPage();
  const history = page.section(HISTORY);
  const original = page.cardWith(history, 'Reversión pedida por user_fran');
  const lines = page.all(original, (n) => n.tagName === 'LI').map((n) => n.textContent);
  assert.equal(lines.length, 2);
  assert.match(lines[0], /^Aceptada por user_fran · \S/);
  assert.match(lines[1], /^Reversión pedida por user_fran · .+ · propuesta inversa /);
  const reverting = page.cardWith(history, 'Revierte el cambio aceptado');
  assert.match(page.all(reverting, (n) => n.tagName === 'LI').map((n) => n.textContent).join('\n'), /^Aceptada por user_fran · /);

  // Each line and each origin links to the item it names.
  const [toInverse] = page.all(original, (n) => n.tagName === 'A' && n.textContent === inverse);
  await toInverse.events.click({ preventDefault() {} });
  assert.equal(page.document.activeElement, reverting);
  const [toOriginal] = page.all(reverting, (n) => n.tagName === 'A' && n.textContent === id);
  await toOriginal.events.click({ preventDefault() {} });
  assert.equal(page.document.activeElement, original);

  for (const card of page.all(history, (n) => n.tagName === 'ARTICLE')) {
    assert.equal(page.buttons(card, 'Volver a revisar').length + page.buttons(card, 'Volver a proponer').length, 1, 'every decided item can be reconsidered');
  }
  await page.click(page.cardWith(history, 'El guardia calló'), 'Volver a revisar');
  assert.equal((await proposal(rejected)).status, 'proposed');
  const back = page.cardWith(page.section(PENDING), 'El guardia calló');
  assert.ok(back && page.buttons(back, 'Aceptar cambio').length === 1, 'it is a review card with Aceptar and Rechazar again');
});

test('a decided claim offers "Deshacer decisión editorial", which takes it out of Canon and back to review', async () => {
  cli('extract', h.bookDir, '--from', join(FIXTURES, 'annotations.json'));
  const queue = await (await reviewApi(h, `/books/${BOOK}`, session)).json();
  const claim = queue.claims.find((c: any) => c.epistemic_kind === 'narrated_fact' && c.evidence_status === 'valid');
  await reviewApi(h, `/books/${BOOK}/claims/${claim.claim_id}`, session, { decision: 'accept' });
  const page = await openPage();

  const canonCard = page.cardWith(page.section('Canon'), claim.statement);
  assert.ok(canonCard.textContent.includes('Aceptada por user_fran'), 'the claim shows who decided and when');
  assert.equal(page.buttons(canonCard, 'Revertir cambio de texto').length, 0);
  await page.click(canonCard, 'Deshacer decisión editorial');
  assert.deepEqual(page.posts().at(-1)!.body, { expected: 1 });
  assert.equal(page.cardWith(page.section('Canon'), claim.statement), undefined, 'it left Canon');
  const pending = page.cardWith(page.section('Afirmaciones por revisar'), claim.statement);
  assert.ok(pending && page.buttons(pending, 'Aceptar').length === 1);
  assert.equal(page.document.activeElement, pending);
});

test('a finding verdict can be taken back; the kept verdict is shown and the finding is pending again', async () => {
  const { findings: [finding] } = h.library.open(BOOK, 'user_fran').proposeFindings([{
    question: 'knowledge', kind: 'fact', statement: 'Elena guarda el puente.', characters: ['Elena'],
    evidence: [{ file: SCENE, quote: 'Elena llevaba once años custodiando el puente de Sal' }],
  }], 'user_fran');
  const findingId = finding.finding_id;
  const verdict = await (await reviewApi(h, `/books/${BOOK}/findings/${findingId}`, session, { verdict: 'useful' })).json();
  const page = await openPage();

  const card = page.cardWith(page.section('Hallazgos de la trama'), 'Elena guarda el puente.');
  await page.click(card, 'Deshacer decisión editorial');
  assert.deepEqual(page.posts().at(-1)!.body, { expected: verdict.at });
  const queue = await (await reviewApi(h, `/books/${BOOK}`, session)).json();
  const view = queue.finding_views.find((f: any) => f.finding_id === findingId);
  assert.equal(view.verdict, undefined);
  assert.equal(view.reopened_verdict.verdict, 'useful');
  const reopened = page.cardWith(page.section('Hallazgos de la trama'), 'Elena guarda el puente.');
  assert.ok(reopened.textContent.includes('Valoración reabierta'));
  assert.equal(page.buttons(reopened, 'Deshacer decisión editorial').length, 0);
  assert.equal(page.buttons(reopened, 'Me ayuda').length, 1, 'it can be rated again');
});
