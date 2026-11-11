/**
 * Which book the review page shows: the one named in the address, else the last one chosen
 * in this browser, else the first. A late answer never brings back a book the person left,
 * and a book that is gone is explained before the page falls back to another.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import { proposeRevision, startHarness, type Harness } from './server-helpers.ts';

const FIRST = 'sal';
const SECOND = 'zeta';
const SECOND_TITLE = 'Zeta';
const SCENE = 'scenes/escena-01.md';
const GONE = /^El libro que tenías abierto ya no está disponible o ya no tienes acceso\. Te mostramos «La puerta de Sal»\.$/;

interface Gate { match: (path: string, method: string) => boolean; release: () => void; reached: Promise<void> }

/**
 * Runs the script the server really serves against a minimal DOM with an address bar,
 * a history and a local storage. Requests can be held back to answer out of order.
 */
async function openPage(h: Harness, session: string, options: { search?: string; stored?: Record<string, string> } = {}) {
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
    selected = false;
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
  const timers: { id: number; run: () => unknown; delay: number }[] = [];
  const reads: string[] = [];
  const gates: Gate[] = [];
  const addresses: string[] = [];
  const stored: Record<string, string> = { ...options.stored };
  const pageListeners: Record<string, (...args: any[]) => any> = {};
  let nextTimer = 0;
  const location = { pathname: '/review', search: options.search ?? '', hash: '' };
  const document = {
    hidden: false,
    activeElement: body as Element,
    getElementById: (id: string) => id === 'app' ? app : id === 'user' ? new Element('div') : all(app, (n) => n.id === id)[0] ?? null,
    createElement: (tag: string) => new Element(tag),
    createTextNode: (text: string) => Object.assign(new Element('#text'), { ownText: text }),
    addEventListener: (name: string, listener: (...args: any[]) => any) => { pageListeners[name] = listener; },
    querySelector: () => null,
  };
  runInNewContext(await (await fetch(`${h.base}/review/app.js`)).text(), {
    document,
    URLSearchParams,
    window: {
      scrollY: 0,
      scrollTo() {},
      scrollBy() {},
      location,
      history: {
        replaceState(_state: unknown, _title: string, url: string) {
          addresses.push(url);
          const parsed = new URL(url, 'https://example.test');
          location.pathname = parsed.pathname;
          location.search = parsed.search;
          location.hash = parsed.hash;
        },
      },
      localStorage: {
        getItem: (key: string) => Object.hasOwn(stored, key) ? stored[key] : null,
        setItem: (key: string, value: string) => { stored[key] = String(value); },
        removeItem: (key: string) => { delete stored[key]; },
      },
      addEventListener: (name: string, listener: (...args: any[]) => any) => { pageListeners[name] = listener; },
      Clerk: { load: async () => {}, isSignedIn: true, mountUserButton() {}, session: { getToken: async () => session } },
    },
    fetch: async (path: string, init: RequestInit = {}) => {
      const method = init.method ?? 'GET';
      const gate = gates.find((g) => g.match(path, method));
      if (gate) {
        gates.splice(gates.indexOf(gate), 1);
        await new Promise<void>((resolve) => { gate.release = resolve; (gate as any).arrived(); });
      }
      if (method === 'GET' && /^\/review\/api\/books\/[^/]+$/.test(path)) reads.push(path.slice('/review/api/books/'.length));
      return fetch(`${h.base}${path}`, init);
    },
    setTimeout: (run: () => unknown, delay: number) => { timers.push({ id: ++nextTimer, run, delay }); return nextTimer; },
    clearTimeout: (id: number) => { const at = timers.findIndex((t) => t.id === id); if (at !== -1) timers.splice(at, 1); },
  });
  await pageListeners.load();

  const picker = () => all(app, (n) => n.tagName === 'SELECT')[0];
  return {
    app, reads, addresses, stored, location,
    picker,
    /** The book the selector shows as chosen. */
    chosen: () => picker().children.find((o) => o.selected)?.value,
    /** Picks a book in the selector, as the person would, and waits for the page. */
    async choose(book: string) {
      picker().value = book;
      await picker().events.change();
    },
    /** Holds back the next request that matches until the test releases it. */
    hold(match: Gate['match']): Gate {
      let arrived!: () => void;
      const reached = new Promise<void>((resolve) => { arrived = resolve; });
      const gate = { match, release: () => {}, reached, arrived } as Gate & { arrived: () => void };
      gates.push(gate);
      return gate;
    },
    buttons: (label: string) => all(app, (n) => n.tagName === 'BUTTON' && n.textContent === label),
    /** The one line that says the book shown is not the one that was open. */
    switchNotice: () => all(app, (n) => n.attrs.role === 'status' && !n.hidden && n.textContent.startsWith('El libro que tenías abierto'))[0]?.textContent,
    async tick() {
      const poll = timers.filter((t) => t.delay >= 1000)[0];
      assert.ok(poll, 'a poll is scheduled');
      timers.splice(timers.indexOf(poll), 1);
      await poll.run();
    },
  };
}

/** Lets every pending promise and request settle. */
async function settle() {
  for (let i = 0; i < 20; i++) await new Promise((resolve) => setTimeout(resolve, 5));
}

async function twoBooks(t: { mock: { method: (...args: any[]) => unknown }; after: (fn: () => void) => void }) {
  t.mock.method(console, 'log', () => {});
  t.mock.method(console, 'warn', () => {});
  t.mock.method(console, 'error', () => {});
  const h = await startHarness();
  t.after(() => h.close());
  h.library.createBook(SECOND, SECOND_TITLE, 'user_fran');
  return { h, session: await h.session() };
}

const storageKey = (stored: Record<string, string>) => Object.keys(stored).find((key) => stored[key] === FIRST || stored[key] === SECOND);

test('without an address or a remembered book, the first book opens', async (t) => {
  const { h, session } = await twoBooks(t);
  const page = await openPage(h, session);
  assert.equal(page.chosen(), FIRST);
  assert.deepEqual(page.reads, [FIRST]);
  assert.match(page.app.textContent, /escena-01/);
  assert.equal(page.switchNotice(), undefined);
});

test('a reload keeps the book named in the address', async (t) => {
  const { h, session } = await twoBooks(t);
  const page = await openPage(h, session, { search: '?book=' + SECOND });
  assert.equal(page.chosen(), SECOND);
  assert.deepEqual(page.reads, [SECOND], 'the first book is never read, so its data never shows');
  assert.doesNotMatch(page.app.textContent, /escena-01/);
  assert.equal(page.location.search, '?book=' + SECOND);
  assert.equal(page.switchNotice(), undefined);
});

test('the last book chosen in this browser opens, and choosing a book records it in the address and the browser', async (t) => {
  const { h, session } = await twoBooks(t);
  const first = await openPage(h, session);
  await first.choose(SECOND);
  assert.equal(first.chosen(), SECOND);
  assert.equal(first.location.search, '?book=' + SECOND);
  const key = storageKey(first.stored);
  assert.ok(key, 'the choice is remembered in this browser');
  assert.equal(first.stored[key], SECOND);

  // A new visit without the address (the assistant sends back to /review?asistente=1).
  const again = await openPage(h, session, { search: '?asistente=1', stored: first.stored });
  assert.equal(again.chosen(), SECOND);
  assert.deepEqual(again.reads, [SECOND]);
  assert.match(again.location.search, /book=zeta/);

  // The address wins over the browser's memory.
  const named = await openPage(h, session, { search: '?book=' + FIRST, stored: first.stored });
  assert.equal(named.chosen(), FIRST);
  assert.deepEqual(named.reads, [FIRST]);
});

test('a late answer never brings back a book the person left', async (t) => {
  const { h, session } = await twoBooks(t);

  await t.test('an action on the first book that finishes after the person changed book', async () => {
    proposeRevision(h.bookDir, SCENE, 'Elena cerró el libro de guardia', 'Elena cerró el cuaderno de guardia');
    const page = await openPage(h, session);
    const gate = page.hold((path, method) => method === 'POST' && path.includes('/proposals/'));
    const clicked = page.buttons('Aceptar cambio')[0].events.click();
    await gate.reached;
    await page.choose(SECOND);
    gate.release();
    await clicked;
    await settle();
    assert.equal(page.chosen(), SECOND);
    assert.equal(page.reads.at(-1), SECOND);
    assert.doesNotMatch(page.app.textContent, /escena-01/);
    assert.equal(page.location.search, '?book=' + SECOND);
  });

  await t.test('a book read that answers after a newer choice', async () => {
    const page = await openPage(h, session);
    const gate = page.hold((path, method) => method === 'GET' && path === '/review/api/books/' + SECOND);
    const slow = page.choose(SECOND);
    await gate.reached;
    await page.choose(FIRST);
    gate.release();
    await slow;
    await settle();
    assert.equal(page.chosen(), FIRST);
    assert.match(page.app.textContent, /escena-01/);
    // Only one toolbar and one set of sections: nothing from the late read was added.
    assert.equal(page.app.children.filter((n) => n.className === 'toolbar').length, 1);
    assert.equal(page.location.search, '?book=' + FIRST);
  });
});

test('a book that is gone or no longer shared is explained in one line before another one shows', async (t) => {
  const { h, session } = await twoBooks(t);

  await t.test('named in the address', async () => {
    const page = await openPage(h, session, { search: '?book=desconocido' });
    assert.equal(page.chosen(), FIRST);
    assert.match(page.switchNotice() ?? '', GONE);
    assert.equal(page.location.search, '?book=' + FIRST);
  });

  await t.test('lost while it is open', async () => {
    const page = await openPage(h, session, { search: '?book=' + SECOND });
    h.library.revoke(SECOND, 'user_fran');
    await page.tick();
    await settle();
    assert.equal(page.chosen(), FIRST);
    assert.match(page.switchNotice() ?? '', GONE);
    assert.equal(page.location.search, '?book=' + FIRST);
    assert.equal(page.stored[storageKey(page.stored)!], FIRST);
    h.library.grant(SECOND, 'user_fran');
  });

  await t.test('remembered by the browser', async () => {
    h.library.revoke(SECOND, 'user_fran');
    const page = await openPage(h, session, { stored: { 'rewrite.book': SECOND } });
    assert.equal(page.chosen(), FIRST);
    assert.match(page.switchNotice() ?? '', GONE);
    assert.equal(page.stored['rewrite.book'], FIRST);
  });
});
