import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import { read } from './helpers.ts';
import { proposeRevision, reviewApi, startHarness, type Harness } from './server-helpers.ts';

const SCENE = 'scenes/escena-01.md';
const DRAFT_KEY = `rewrite:draft:sal:${SCENE}`;

/**
 * Runs the script the server really serves against a minimal DOM, as review-refresh.test.ts
 * does, plus the session storage and confirm dialog the scene editor uses.
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
    spellcheck = false;
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
  const pageListeners: Record<string, (...args: any[]) => any> = {};
  const storage = new Map<string, string>();
  const confirms: string[] = [];
  let confirmAnswer = true;
  let nextTimer = 0;
  const document = {
    hidden: false,
    activeElement: body as Element,
    getElementById: (id: string) => id === 'app' ? app : id === 'user' ? new Element('div') : all(app, (n) => n.id === id)[0] ?? null,
    createElement: (tag: string) => new Element(tag),
    createTextNode: (text: string) => Object.assign(new Element('#text'), { ownText: text }),
    addEventListener: (name: string, listener: (...args: any[]) => any) => { pageListeners[`document:${name}`] = listener; },
    querySelector: () => null,
  };
  runInNewContext(await (await fetch(`${h.base}/review/app.js`)).text(), {
    document,
    window: {
      scrollY: 0,
      scrollTo() {},
      scrollBy() {},
      addEventListener: (name: string, listener: (...args: any[]) => any) => { pageListeners[name] = listener; },
      confirm: (message: string) => { confirms.push(message); return confirmAnswer; },
      sessionStorage: {
        getItem: (key: string) => storage.get(key) ?? null,
        setItem: (key: string, value: string) => { storage.set(key, value); },
        removeItem: (key: string) => { storage.delete(key); },
      },
      Clerk: { load: async () => {}, isSignedIn: true, mountUserButton() {}, session: { getToken: async () => session } },
    },
    fetch: (path: string, init: RequestInit = {}) => fetch(`${h.base}${path}`, init),
    setTimeout: (run: () => unknown, delay: number) => { timers.push({ id: ++nextTimer, run, delay }); return nextTimer; },
    clearTimeout: (id: number) => { const at = timers.findIndex((t) => t.id === id); if (at !== -1) timers.splice(at, 1); },
  });
  await pageListeners.load();

  const button = (label: string): Element => {
    const found = all(app, (n) => n.tagName === 'BUTTON' && n.textContent === label && !n.hidden);
    assert.equal(found.length, 1, `one visible "${label}" button`);
    return found[0];
  };
  const editor = (): Element | undefined => all(app, (n) => n.tagName === 'TEXTAREA')[0];
  const status = (): string => all(app, (n) => n.className.includes('save-status'))[0]?.textContent ?? '';
  return {
    app, storage, confirms, pageListeners,
    setConfirm(answer: boolean) { confirmAnswer = answer; },
    button, editor, status,
    async click(label: string) { await button(label).events.click(); },
    async type(text: string) {
      const area = editor();
      assert.ok(area, 'the editor is open');
      area.value = text;
      await area.events.input?.();
    },
    async openEditor() {
      await button(SCENE).events.click();
      await button('Editar escena').events.click();
      assert.ok(editor(), 'the editor is open');
    },
    /** Lets the pending background refresh fire. */
    async poll() {
      const poll = timers.find((t) => t.delay >= 1000);
      assert.ok(poll, 'a poll is scheduled');
      timers.splice(timers.indexOf(poll), 1);
      await poll.run();
    },
    notice: () => all(app, (n) => n.attrs.role === 'status' && /Hay novedades/.test(n.textContent) && !n.hidden)[0],
    sceneText: (): string => all(app, (n) => n.tagName === 'PRE' && n.parent?.parent?.className === 'scene-viewer')[0]?.textContent ?? '',
  };
}

async function quietPage(t: any) {
  t.mock.method(console, 'log', () => {});
  t.mock.method(console, 'warn', () => {});
  t.mock.method(console, 'error', () => {});
  const h = await startHarness();
  t.after(() => h.close());
  const session = await h.session();
  return { h, session, page: await openPage(h, session) };
}

/** Someone else saves the scene through the API, as another tab would. */
async function saveElsewhere(h: Harness, session: string, change: (text: string) => string) {
  const path = `/books/sal/scenes/${encodeURIComponent(SCENE)}`;
  const scene = await (await reviewApi(h, path, session)).json();
  const res = await reviewApi(h, path, session, { base_blob: scene.blob, text: change(scene.text) });
  assert.equal(res.status, 200);
}

test('a person edits a scene on the page, saves it, and a poll never closes the editor', async (t) => {
  const { h, page } = await quietPage(t);
  await page.openEditor();
  const original = read(h.bookDir, SCENE);
  assert.equal(page.editor()!.value, original, 'the editor holds the stored Markdown as it is');
  assert.equal(page.editor()!.attrs['aria-label'], `Texto de la escena ${SCENE}`);

  const mine = original + '\nUn párrafo *nuevo*.\n';
  await page.type(mine);
  assert.equal(page.status(), 'Cambios sin guardar');
  assert.equal(JSON.parse(page.storage.get(DRAFT_KEY)!).text, mine, 'the unsaved text is kept in this tab');
  proposeRevision(h.bookDir, 'scenes/escena-02.md', 'una vela casi consumida', 'una vela nueva');
  await page.poll();
  assert.ok(page.editor(), 'a background refresh with news does not re-render over an open editor');
  assert.equal(page.editor()!.value, mine);
  assert.ok(page.notice(), 'the news waits behind a notice instead');

  await page.click('Guardar');
  assert.equal(read(h.bookDir, SCENE), mine);
  assert.equal(page.status(), 'Guardado');
  assert.equal(page.storage.has(DRAFT_KEY), false);
  assert.equal(page.editor()!.value, mine, 'the person keeps writing after a save');

  await page.click('Cerrar editor');
  assert.equal(page.confirms.length, 0, 'closing with nothing unsaved asks nothing');
  assert.equal(page.editor(), undefined);
  assert.equal(page.sceneText(), mine);
});

test('a save refused because the scene changed keeps the person\'s text and offers both ways out', async (t) => {
  const { h, session, page } = await quietPage(t);
  await page.openEditor();
  const opened = page.editor()!.value;
  await saveElsewhere(h, session, (text) => text.replace('once años', 'doce años'));
  const elsewhere = read(h.bookDir, SCENE);

  await page.type(opened + 'Mío.\n');
  await page.click('Guardar');
  assert.match(page.status(), /^No se guardó: la escena cambió mientras editabas/);
  assert.equal(page.editor()!.value, opened + 'Mío.\n');
  assert.equal(read(h.bookDir, SCENE), elsewhere, 'nothing was overwritten');
  assert.ok(page.storage.has(DRAFT_KEY), 'the refused text is still kept in this tab');

  await page.click('Usar la versión guardada');
  assert.equal(page.editor()!.value, elsewhere);
  assert.equal(page.storage.has(DRAFT_KEY), false);

  await page.type(elsewhere + 'Otra vez mío.\n');
  await saveElsewhere(h, session, (text) => text.replace('El guardia no preguntó', 'El guardia calló'));
  await page.click('Guardar');
  assert.match(page.status(), /^No se guardó/);
  await page.click('Guardar mi versión encima');
  assert.equal(read(h.bookDir, SCENE), elsewhere + 'Otra vez mío.\n', 'the person chose to save over it, after seeing it');
  assert.equal(page.status(), 'Guardado');
});

test('an unsaved edit survives the scene being reopened in the same tab, and closing it asks first', async (t) => {
  const { h, page } = await quietPage(t);
  await page.openEditor();
  const draft = page.editor()!.value + 'Sin guardar.\n';
  await page.type(draft);
  assert.equal(page.pageListeners.beforeunload ? (() => {
    const event = { prevented: false, returnValue: undefined as unknown, preventDefault() { this.prevented = true; } };
    page.pageListeners.beforeunload(event);
    return event.prevented;
  })() : false, true, 'leaving the page with unsaved text asks first');

  await page.openEditor();
  assert.equal(page.editor()!.value, draft);
  assert.equal(page.status(), 'Se recuperó un texto sin guardar de esta pestaña.');

  page.setConfirm(false);
  await page.click('Cerrar editor');
  assert.equal(page.confirms.length, 1);
  assert.ok(page.editor(), 'answering no keeps the editor open');
  page.setConfirm(true);
  await page.click('Cerrar editor');
  assert.equal(page.editor(), undefined);
  assert.equal(page.storage.has(DRAFT_KEY), false, 'a discarded draft is gone');
  assert.notEqual(read(h.bookDir, SCENE), draft);
});
