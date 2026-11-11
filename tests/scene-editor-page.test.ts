import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { runInNewContext } from 'node:vm';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { git, read } from './helpers.ts';
import { proposeRevision, reviewApi, startHarness, type Harness } from './server-helpers.ts';

const SCENE = 'scenes/escena-01.md';
/** Drafts are kept per person: a hash of the session's subject, never the subject itself. */
const draftKeyOf = (session: string) => {
  const sub = JSON.parse(Buffer.from(session.split('.')[1], 'base64url').toString('utf8')).sub;
  return `rewrite:draft:${createHash('sha256').update(`rewrite:person:${sub}`).digest('hex').slice(0, 32)}:sal:${SCENE}`;
};
let DRAFT_KEY = '';

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
    private raw = '';
    defaultValue = '';
    readOnly = false;
    // A browser normalises a text field's value: CRLF and a lone CR become LF (HTML, "API value").
    get value(): string { return this.raw; }
    set value(text: string) { this.raw = this.tagName === 'TEXTAREA' ? String(text).replace(/\r\n?/g, '\n') : text; }
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
  const posts: string[] = [];
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
    crypto,
    TextEncoder,
    atob,
    fetch: (path: string, init: RequestInit = {}) => {
      if (init.method === 'POST') posts.push(path);
      return fetch(`${h.base}${path}`, init);
    },
    setTimeout: (run: () => unknown, delay: number) => { timers.push({ id: ++nextTimer, run, delay }); return nextTimer; },
    clearTimeout: (id: number) => { const at = timers.findIndex((t) => t.id === id); if (at !== -1) timers.splice(at, 1); },
  });
  DRAFT_KEY = draftKeyOf(session);
  await pageListeners.load();

  const button = (label: string): Element => {
    const found = all(app, (n) => n.tagName === 'BUTTON' && n.textContent === label && !n.hidden);
    assert.equal(found.length, 1, `one visible "${label}" button`);
    return found[0];
  };
  const editor = (): Element | undefined => all(app, (n) => n.tagName === 'TEXTAREA')[0];
  const status = (): string => all(app, (n) => n.className.includes('save-status'))[0]?.textContent ?? '';
  return {
    app, storage, confirms, pageListeners, posts,
    visible: (label: string): number => all(app, (n) => n.tagName === 'BUTTON' && n.textContent === label && !n.hidden).length,
    text: (pattern: RegExp): boolean => all(app, (n) => n.tagName === 'P' && pattern.test(n.textContent)).length > 0,
    setConfirm(answer: boolean) { confirmAnswer = answer; },
    button, editor, status,
    async click(label: string) { await button(label).events.click(); },
    async type(text: string) {
      const area = editor();
      assert.ok(area, 'the editor is open');
      area.value = text;
      await area.events.input?.();
    },
    async openEditor(file = SCENE) {
      await button(file).events.click();
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

async function quietPage(t: any, setup?: (h: Harness) => void) {
  t.mock.method(console, 'log', () => {});
  t.mock.method(console, 'warn', () => {});
  t.mock.method(console, 'error', () => {});
  const h = await startHarness();
  t.after(() => h.close());
  const session = await h.session();
  setup?.(h);
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

/** Commits a scene with exactly these bytes, as an import of a file from any editor would. */
function commitScene(h: Harness, file: string, text: string) {
  writeFileSync(join(h.bookDir, file), text);
  git(h.bookDir, 'add', file);
  git(h.bookDir, 'commit', '-q', '-m', `add ${file}`, '--', file);
}

test('CRLF and LF scenes keep their line endings, and opening one never marks it unsaved', async (t) => {
  const CRLF = 'scenes/crlf.md';
  const { h, page } = await quietPage(t, (h) => commitScene(h, CRLF, '# Uno\r\n\r\nDos.\r\n'));
  await page.openEditor(CRLF);
  assert.equal(page.editor()!.value, '# Uno\n\nDos.\n');
  assert.equal([...page.storage.keys()].filter((key) => key.startsWith('rewrite:draft:')).length, 0, 'nothing unsaved after opening');
  await page.click('Guardar');
  assert.equal(page.posts.length, 0, 'saving an unchanged scene sends nothing');
  await page.type('# Uno\n\nDos.\nTres.\n');
  await page.click('Guardar');
  assert.equal(read(h.bookDir, CRLF), '# Uno\r\n\r\nDos.\r\nTres.\r\n');
  await page.click('Cerrar editor');
  assert.equal(page.confirms.length, 0);
});

test('a scene with mixed line endings or a lone CR opens read-only until the person normalises it', async (t) => {
  const MIXED = 'scenes/mixed.md';
  const LONE = 'scenes/lone-cr.md';
  const { h, page } = await quietPage(t, (h) => {
    commitScene(h, MIXED, 'a\r\nb\nc\n');
    commitScene(h, LONE, 'x\ry\n');
  });
  for (const [file, normalised] of [[MIXED, 'a\nb\nc\n'], [LONE, 'x\ny\n']]) {
    const before = read(h.bookDir, file);
    await page.openEditor(file);
    assert.equal(page.editor()!.readOnly, true);
    assert.ok(page.text(/mezcla finales de línea/), 'one line explains why');
    assert.equal(page.visible('Guardar'), 0, 'nothing can be saved before normalising');
    assert.equal([...page.storage.keys()].filter((key) => key.startsWith('rewrite:draft:')).length, 0);
    await page.click('Cerrar editor');
    assert.equal(page.confirms.length, 0, 'opening and closing is not an unsaved change');
    assert.equal(read(h.bookDir, file), before);

    await page.openEditor(file);
    await page.click('Normalizar los finales de línea y editar');
    assert.equal(page.editor()!.readOnly, false);
    await page.click('Guardar');
    assert.equal(read(h.bookDir, file), normalised, 'the explicit action is the only way the endings change');
    assert.match(page.status(), /finales de línea/);
    await page.click('Cerrar editor');
  }
});

test('a second save while one is in flight is not sent, so the person never conflicts with themselves', async (t) => {
  const { h, page } = await quietPage(t);
  await page.openEditor();
  const mine = page.editor()!.value + 'Rápido.\n';
  await page.type(mine);
  const ctrlS = () => page.editor()!.events.keydown({ ctrlKey: true, key: 's', preventDefault() {} });
  ctrlS();
  ctrlS();
  for (let i = 0; i < 200 && page.status() !== 'Guardado'; i++) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(page.status(), 'Guardado');
  assert.equal(page.posts.length, 1);
  assert.equal(read(h.bookDir, SCENE), mine);
});
