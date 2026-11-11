import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import { proposeRevision, reviewApi, startHarness, type Harness } from './server-helpers.ts';

const BOOK = 'sal';
const SCENE = 'scenes/escena-01.md';
const OTHER_SCENE = 'scenes/escena-02.md';
const QUEUE_ROUTE = `/review/api/books/${BOOK}`;
const NOTE_LABEL = 'Nota opcional sobre la valoración';
const STALE_BADGE = 'No aplicable: la escena ha cambiado';
const STALE_REASON = 'La escena ha cambiado desde esta propuesta: ya no se puede aplicar.';

interface Timer { id: number; run: () => unknown; delay: number }
interface Call { path: string; method: string; status: number; etag: string | null }

/**
 * Runs the script the server really serves against a minimal DOM. Timers are
 * collected instead of scheduled, so a test decides when the page polls.
 */
async function openPage(h: Harness, session: string) {
  class Element {
    tagName: string;
    children: Element[] = [];
    parent: Element | null = null;
    ownText = '';
    className = '';
    id = '';
    type = '';
    value = '';
    defaultValue = '';
    files: unknown[] | null = null;
    hidden = false;
    disabled = false;
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
  const timers: Timer[] = [];
  const calls: Call[] = [];
  const pageListeners: Record<string, (...args: any[]) => any> = {};
  let nextTimer = 0;
  const document = {
    hidden: false,
    activeElement: body as Element,
    /** What a selector for an open dialog finds; the page never builds one itself. */
    dialog: null as Element | null,
    getElementById: (id: string) => id === 'app' ? app : id === 'user' ? new Element('div') : all(app, (n) => n.id === id)[0] ?? null,
    createElement: (tag: string) => new Element(tag),
    createTextNode: (text: string) => Object.assign(new Element('#text'), { ownText: text }),
    addEventListener: (name: string, listener: (...args: any[]) => any) => { pageListeners[name] = listener; },
    querySelector: () => document.dialog,
  };
  runInNewContext(await (await fetch(`${h.base}/review/app.js`)).text(), {
    document,
    window: {
      scrollY: 0,
      scrollTo() {},
      scrollBy() {},
      addEventListener: (name: string, listener: (...args: any[]) => any) => { pageListeners[name] = listener; },
      Clerk: { load: async () => {}, isSignedIn: true, mountUserButton() {}, session: { getToken: async () => session } },
    },
    fetch: async (path: string, init: RequestInit = {}) => {
      const response = await fetch(`${h.base}${path}`, init);
      calls.push({ path, method: init.method ?? 'GET', status: response.status, etag: response.headers.get('etag') });
      return response;
    },
    setTimeout: (run: () => unknown, delay: number) => { timers.push({ id: ++nextTimer, run, delay }); return nextTimer; },
    clearTimeout: (id: number) => { const at = timers.findIndex((t) => t.id === id); if (at !== -1) timers.splice(at, 1); },
  });
  await pageListeners.load();

  // Scene highlighting also uses a short timer; a poll is the only one measured in seconds.
  const polls = () => timers.filter((t) => t.delay >= 1000);
  const section = (title: string): Element => {
    const found = all(app, (n) => n.tagName === 'SECTION' && all(n, (c) => c.tagName === 'H2')[0]?.textContent === title)[0];
    assert.ok(found, `section "${title}" is rendered`);
    return found;
  };
  return {
    app, body, document, calls, polls, section, all,
    /** Lets the pending poll fire, as the clock would a few seconds later. */
    async tick() {
      const [poll, ...rest] = polls();
      assert.ok(poll, 'a poll is scheduled');
      assert.equal(rest.length, 0, 'only one poll is ever pending');
      timers.splice(timers.indexOf(poll), 1);
      await poll.run();
    },
    async setHidden(hidden: boolean) {
      document.hidden = hidden;
      await pageListeners.visibilitychange();
    },
    cards: (root: Element) => all(root, (n) => n.tagName === 'ARTICLE'),
    buttons: (root: Element, label: string) => all(root, (n) => n.tagName === 'BUTTON' && n.textContent === label),
    cardWith: (root: Element, text: string) => all(root, (n) => n.tagName === 'ARTICLE' && n.textContent.includes(text))[0],
    attached: (node: Element) => all(app, (n) => n === node).length === 1,
    notice: () => all(app, (n) => n.attrs.role === 'status' && /Hay novedades/.test(n.textContent) && !n.hidden)[0],
  };
}

test('the queue read is conditional, so polling it is cheap', async (t) => {
  t.mock.method(console, 'log', () => {});
  t.mock.method(console, 'warn', () => {});
  const h = await startHarness();
  t.after(() => h.close());
  const session = await h.session();
  const get = (headers: Record<string, string> = {}) =>
    fetch(`${h.base}${QUEUE_ROUTE}`, { headers: { authorization: `Bearer ${session}`, ...headers } });

  await t.test('a conditional read answers 304 with no body until the queue changes', async () => {
    const first = await get();
    const etag = first.headers.get('etag');
    assert.equal(first.status, 200);
    assert.match(etag ?? '', /^"[A-Za-z0-9_-]+"$/);
    await first.arrayBuffer();

    const unchanged = await get({ 'if-none-match': etag! });
    assert.equal(unchanged.status, 304);
    assert.equal(unchanged.headers.get('etag'), etag);
    assert.equal(unchanged.headers.get('cache-control'), 'no-store');
    assert.equal((await unchanged.arrayBuffer()).byteLength, 0);

    const id = proposeRevision(h.bookDir, OTHER_SCENE, 'una vela casi consumida', 'una vela nueva');
    const changed = await get({ 'if-none-match': etag! });
    assert.equal(changed.status, 200);
    assert.notEqual(changed.headers.get('etag'), etag);
    assert.ok((await changed.json()).proposals.some((p: any) => p.proposal.proposal_id === id));
  });

  await t.test('a plain read of the queue still returns the whole body, never cached', async () => {
    const response = await get();
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type') ?? '', /^application\/json/);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    const queue = await response.json();
    assert.deepEqual(Object.keys(queue).sort(), ['canon', 'claims', 'finding_views', 'findings', 'proposals', 'scenes']);
    assert.deepEqual(queue.scenes, [SCENE, OTHER_SCENE]);
    // A stale validator is not an error: the caller simply gets the current state.
    const stale = await get({ 'if-none-match': '"not-the-current-state"' });
    assert.equal(stale.status, 200);
    assert.deepEqual(await stale.json(), queue);
  });
});

test('the review page refreshes its state without a manual reload', async (t) => {
  const lines: string[] = [];
  t.mock.method(console, 'log', (...args: unknown[]) => lines.push(args.join(' ')));
  t.mock.method(console, 'error', () => {});
  t.mock.method(console, 'warn', () => {});
  const h = await startHarness();
  t.after(() => h.close());
  const session = await h.session();
  const elsewhere = (id: string, decision: 'accept' | 'reject') => reviewApi(h, `/books/${BOOK}/proposals/${id}`, session, { decision });

  const QUOTE = 'Elena cerró el libro de guardia y lo miró sin parpadear.';
  const FIRST = 'Elena cerró el libro de guardia y sostuvo la mirada.';
  const SECOND = 'Elena apartó el libro de guardia sin levantar la vista.';
  h.library.open(BOOK, 'user_fran').proposeFindings([{
    question: 'knowledge', kind: 'fact', statement: 'Clara encuentra la llave.', characters: ['Clara'],
    evidence: [{ file: OTHER_SCENE, quote: 'Clara levantó la losa del altar' }],
  }], 'user_fran');

  const page = await openPage(h, session);
  const pending = () => page.section('Cambios propuestos');
  let first = '';
  let second = '';

  await t.test('a proposal made elsewhere appears on the next poll, a few seconds later', async () => {
    assert.equal(page.cards(pending()).length, 0);
    assert.equal(page.polls().length, 1);
    assert.ok(page.polls()[0].delay <= 5000, 'the page polls within a few seconds');
    first = proposeRevision(h.bookDir, SCENE, QUOTE, FIRST);
    second = proposeRevision(h.bookDir, SCENE, QUOTE, SECOND);
    await page.tick();
    for (const text of [FIRST, SECOND]) {
      const card = page.cardWith(pending(), text);
      assert.ok(card, `${text} is shown`);
      assert.ok(card.textContent.includes('Pendiente'));
      assert.equal(page.buttons(card, 'Aceptar cambio').length, 1);
    }
  });

  await t.test('an unchanged queue costs a 304 and leaves the rendered cards alone', async () => {
    const card = page.cardWith(pending(), FIRST);
    await page.tick();
    assert.equal(page.calls.at(-1)!.status, 304);
    assert.equal(page.calls.at(-1)!.path, QUEUE_ROUTE);
    assert.ok(page.attached(card), 'the same card node is still on the page');
    assert.equal(page.polls().length, 1);
  });

  await t.test('a decision made elsewhere reaches history, and the open card that became stale warns and cannot be accepted', async () => {
    const [sceneButton] = page.buttons(page.section('Navegar escenas'), SCENE);
    await sceneButton.events.click();
    const viewer = () => page.all(page.app, (n) => n.className === 'scene-viewer')[0];
    assert.equal(page.buttons(page.cardWith(viewer(), SECOND), 'Aceptar cambio').length, 1);

    assert.equal((await elsewhere(first, 'accept')).status, 200);
    await page.tick();

    const decided = page.cardWith(page.section('Historial de cambios del manuscrito'), FIRST);
    assert.ok(decided.textContent.includes('Aceptada'));
    assert.equal(page.cardWith(pending(), FIRST), undefined);
    for (const card of [page.cardWith(pending(), SECOND), page.cardWith(viewer(), SECOND)]) {
      assert.ok(card.textContent.includes(STALE_BADGE));
      assert.ok(card.textContent.includes(STALE_REASON));
      assert.equal(page.buttons(card, 'Aceptar cambio').length, 0);
      assert.equal(page.buttons(card, 'Rechazar').length, 1);
    }
    assert.ok(viewer().textContent.includes(FIRST), 'the open scene shows the accepted text');
  });

  const noteInput = () => page.all(page.section('Hallazgos de la trama'), (n) => n.attrs['aria-label'] === NOTE_LABEL)[0];

  await t.test('no refresh while a note is being typed: the text survives and a notice says why', async () => {
    const input = noteInput();
    input.focus();
    input.value = 'Un borrador de nota';
    assert.equal((await elsewhere(second, 'reject')).status, 200);
    await page.tick();
    assert.ok(page.attached(input), 'the note field was not replaced');
    assert.equal(input.value, 'Un borrador de nota');
    assert.ok(page.cardWith(pending(), SECOND), 'the queue was not re-rendered');
    assert.ok(page.notice(), 'a notice says there is news waiting');

    // Leaving the field does not make the unsaved text disposable.
    page.body.focus();
    await page.tick();
    assert.ok(page.attached(input));
    assert.equal(input.value, 'Un borrador de nota');
    assert.ok(page.cardWith(pending(), SECOND));

    input.value = '';
    await page.tick();
    assert.equal(page.cardWith(pending(), SECOND), undefined);
    assert.ok(page.cardWith(page.section('Historial de cambios del manuscrito'), SECOND).textContent.includes('Rechazada'));
    assert.equal(page.notice(), undefined);
  });

  await t.test('no refresh while a dialog is open', async () => {
    const replacement = 'una palanca y un farol';
    page.document.dialog = page.body;
    const id = proposeRevision(h.bookDir, OTHER_SCENE, 'una palanca y una vela casi consumida', replacement);
    await page.tick();
    assert.equal(page.cardWith(pending(), replacement), undefined);
    assert.ok(page.notice());

    page.document.dialog = null;
    await page.tick();
    assert.ok(page.cardWith(pending(), replacement));
    assert.equal(page.notice(), undefined);
    assert.equal((await elsewhere(id, 'reject')).status, 200);
    await page.tick();
  });

  await t.test('a hidden tab makes no request, and catches up as soon as it is visible again', async () => {
    const replacement = 'envuelta en un paño húmedo';
    await page.setHidden(true);
    assert.equal(page.polls().length, 0, 'no poll is scheduled while hidden');
    const before = page.calls.length;
    proposeRevision(h.bookDir, OTHER_SCENE, 'envuelta en un paño seco', replacement);
    assert.equal(page.calls.length, before);
    assert.equal(page.cardWith(pending(), replacement), undefined);

    await page.setHidden(false);
    assert.ok(page.cardWith(pending(), replacement));
    assert.equal(page.polls().length, 1);
  });

  await t.test('polling only reads, and each poll is one metadata-only log line', async () => {
    const polled = page.calls.filter((call) => call.path === QUEUE_ROUTE);
    assert.ok(polled.length >= 8);
    assert.ok(page.calls.every((call) => call.method === 'GET'), 'the page never wrote on its own');
    const records = lines.map((line) => JSON.parse(line)).filter((r) => r.event === 'http.request' && r.status === 304);
    assert.equal(records.length, polled.filter((call) => call.status === 304).length);
    for (const record of records) {
      assert.deepEqual(Object.keys(record).sort(), ['book', 'door', 'duration_ms', 'event', 'method', 'request_id', 'route', 'status', 'subject', 'timestamp']);
      assert.equal(record.route, '/review/api/books/:book');
      assert.equal(record.method, 'GET');
    }
    const output = lines.join('\n');
    for (const etag of new Set(polled.map((call) => call.etag))) assert.ok(etag && !output.includes(etag.replaceAll('"', '')), 'validators stay out of the log');
    for (const text of [QUOTE, FIRST, SECOND, 'Un borrador de nota', session]) assert.ok(!output.includes(text));
  });
});
