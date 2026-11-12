import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { runInNewContext } from 'node:vm';
import { join } from 'node:path';
import { cli, FIXTURES, git, read } from './helpers.ts';
import { Project } from '../src/application/project.ts';
import { proposeRevision, reviewApi, startHarness, type Harness } from './server-helpers.ts';
import { REVIEW_CSS } from '../src/adapters/review-page.ts';

// The writing modes of issue #101 (docs/design.md, "Modes"): Concentración and Ayuda RE;write
// around one scene editor, and Revisión, the full review page. The script the server really
// serves runs against a small DOM; layout itself is covered by the browser tests.

const SCENE = 'scenes/escena-01.md';
const OTHER = 'scenes/escena-02.md';
const personOf = (session: string) => {
  const sub = JSON.parse(Buffer.from(session.split('.')[1], 'base64url').toString('utf8')).sub;
  return createHash('sha256').update(`rewrite:person:${sub}`).digest('hex').slice(0, 32);
};

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
  spellcheck = false;
  files: unknown[] | null = null;
  hidden = false;
  disabled = false;
  tabIndex = -1;
  title = '';
  selection: [number, number] | null = null;
  style: Record<string, string> = {};
  attrs: Record<string, string> = {};
  events: Record<string, (...args: any[]) => any> = {};
  classList = { add() {}, remove() {}, contains: () => false, toggle() {} };
  constructor(tag: string) { this.tagName = tag.toUpperCase(); }
  get value(): string {
    if (this.tagName === 'SELECT') return (this.children.find((o) => o.attrs.selected === 'true') ?? this.children[0])?.value ?? '';
    return this.raw;
  }
  set value(text: string) {
    if (this.tagName === 'SELECT') {
      for (const option of this.children) option.attrs.selected = String(option.value === text);
      return;
    }
    this.raw = this.tagName === 'TEXTAREA' ? String(text).replace(/\r\n?/g, '\n') : text;
  }
  set selected(on: boolean) { this.attrs.selected = String(on); }
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
  removeAttribute(key: string) { delete this.attrs[key]; }
  addEventListener(name: string, listener: (...args: any[]) => any) { this.events[name] = listener; }
  getElementsByTagName(tag: string): Element[] { return all(this, (n) => n !== this && n.tagName === tag.toUpperCase()); }
  closest(selector: string): Element | null {
    for (let node: Element | null = this; node; node = node.parent) {
      if (selector.startsWith('#') ? node.id === selector.slice(1) : node.tagName === selector.toUpperCase()) return node;
    }
    return null;
  }
  contains(other: Element | null): boolean {
    for (let node = other; node; node = node.parent) if (node === this) return true;
    return false;
  }
  get isConnected(): boolean { let node: Element = this; while (node.parent) node = node.parent; return node.tagName === 'BODY'; }
  getBoundingClientRect() { return { top: 0 }; }
  scrollIntoView() { scrolled.push(this); }
  focus() { document.activeElement = this; }
  setSelectionRange(start: number, end: number) { this.selection = [start, end]; }
}
let document: any;
const scrolled: Element[] = [];
function all(root: Element, match: (node: Element) => boolean): Element[] {
  return [...(match(root) ? [root] : []), ...root.children.flatMap((c) => all(c, match))];
}
/** Hidden itself or inside something hidden: what a person cannot see. */
const shown = (node: Element): boolean => { for (let n: Element | null = node; n; n = n.parent) if (n.hidden) return false; return true; };

async function openPage(h: Harness, session: string, local = new Map<string, string>()) {
  const body = new Element('body');
  const app = new Element('main');
  app.id = 'app';
  body.append(app);
  const timers: { id: number; run: () => unknown; delay: number }[] = [];
  const listeners: Record<string, (...args: any[]) => any> = {};
  const storage = new Map<string, string>();
  const gets: string[] = [];
  let nextTimer = 0;
  const store = (map: Map<string, string>) => ({
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => { map.set(key, value); },
    removeItem: (key: string) => { map.delete(key); },
    get length() { return map.size; },
    key: (i: number) => [...map.keys()][i] ?? null,
  });
  document = {
    hidden: false,
    body,
    activeElement: body,
    getElementById: (id: string) => all(body, (n) => n.id === id)[0] ?? null,
    createElement: (tag: string) => new Element(tag),
    createTextNode: (text: string) => Object.assign(new Element('#text'), { ownText: text }),
    addEventListener: (name: string, listener: (...args: any[]) => any) => { listeners[`document:${name}`] = listener; },
    querySelector: () => null,
  };
  runInNewContext(await (await fetch(`${h.base}/review/app.js`)).text(), {
    document,
    window: {
      scrollY: 0,
      location: { search: '', pathname: '/review', hash: '' },
      history: { state: null, replaceState() {} },
      scrollTo() {},
      scrollBy() {},
      addEventListener: (name: string, listener: (...args: any[]) => any) => { listeners[name] = listener; },
      confirm: () => true,
      sessionStorage: store(storage),
      localStorage: store(local),
      Clerk: { load: async () => {}, isSignedIn: true, mountUserButton() {}, session: { getToken: async () => session } },
    },
    URLSearchParams,
    crypto,
    TextEncoder,
    atob,
    fetch: (path: string, init: RequestInit = {}) => {
      if (!init.method || init.method === 'GET') gets.push(path);
      return fetch(`${h.base}${path}`, init);
    },
    setTimeout: (run: () => unknown, delay: number) => { timers.push({ id: ++nextTimer, run, delay }); return nextTimer; },
    clearTimeout: (id: number) => { const at = timers.findIndex((t) => t.id === id); if (at !== -1) timers.splice(at, 1); },
  });
  await listeners.load();

  const find = (match: (n: Element) => boolean) => all(body, match);
  const desk = () => document.getElementById('desk') as Element | null;
  const button = (label: string, root: Element = body): Element => {
    const found = all(root, (n) => n.tagName === 'BUTTON' && n.textContent === label && shown(n));
    assert.equal(found.length, 1, `one visible "${label}" button`);
    return found[0];
  };
  /** Runs the short timers the page set (none of them is the background poll). */
  const settle = async () => {
    for (let round = 0; round < 5; round++) {
      const due = timers.filter((t) => t.delay < 1000);
      if (!due.length) return;
      for (const timer of due) { timers.splice(timers.indexOf(timer), 1); await timer.run(); }
    }
  };
  return {
    body, app, storage, local, gets,
    mode: () => body.attrs['data-mode'],
    desk,
    button,
    async click(label: string, root?: Element) { await button(label, root).events.click(); await settle(); },
    async pick(mode: string) {
      const group = find((n) => n.attrs.role === 'group' && n.attrs['aria-label'] === 'Modo')[0];
      assert.ok(group, 'the mode switch is in the page');
      await button(mode, group).events.click();
      await settle();
    },
    switchState: () => Object.fromEntries(find((n) => n.attrs.role === 'group' && n.attrs['aria-label'] === 'Modo')[0].children.map((b) => [b.textContent, b.attrs['aria-pressed']])),
    editor: (): Element | undefined => all(desk() ?? new Element('x'), (n) => n.tagName === 'TEXTAREA')[0],
    async type(text: string) {
      const area = all(desk()!, (n) => n.tagName === 'TEXTAREA')[0];
      area.value = text;
      await area.events.input?.();
    },
    help: (): Element | undefined => all(desk() ?? new Element('x'), (n) => n.tagName === 'ASIDE')[0],
    texts: (root: Element, tag: string) => all(root, (n) => n.tagName === tag.toUpperCase() && shown(n)).map((n) => n.textContent),
    async poll() {
      // The background refresh (REFRESH_MS), not the editor module's load timeout.
      const poll = timers.find((t) => t.delay === 5000);
      assert.ok(poll, 'a poll is scheduled');
      timers.splice(timers.indexOf(poll), 1);
      await poll.run();
      await settle();
    },
    settle,
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

test('the page starts in Revisión, and a chosen mode is remembered per person in this browser', async (t) => {
  const { h, session, page } = await quietPage(t);
  assert.equal(page.mode(), 'review', 'without a choice nothing existing changes');
  assert.deepEqual(page.switchState(), { 'Concentración': 'false', 'Ayuda RE;write': 'false', 'Libro': 'false', 'Revisión': 'true' });

  await page.pick('Concentración');
  assert.equal(page.mode(), 'focus');
  assert.deepEqual(page.switchState(), { 'Concentración': 'true', 'Ayuda RE;write': 'false', 'Libro': 'false', 'Revisión': 'false' });
  assert.equal(page.local.get(`rewrite:mode:${personOf(session)}`), 'focus', 'kept under the hash of the person, never the person');

  const again = await openPage(h, session, page.local);
  await again.settle();
  assert.equal(again.mode(), 'focus', 'a reload comes back to the chosen mode');
  assert.equal(again.editor()?.value, read(h.bookDir, SCENE), 'with the scene in the editor');
  const stranger = await openPage(h, await h.session('user_other'), page.local);
  assert.equal(stranger.mode(), 'review', 'another person in the same browser does not inherit the choice');
});

test('Concentración shows only the open scene in the editor: no review, no help, no assistant', async (t) => {
  const { h, page } = await quietPage(t, (h) => {
    cli('extract', h.bookDir, '--from', join(FIXTURES, 'annotations.json'));
    proposeRevision(h.bookDir, SCENE, 'once años', 'doce años');
  });
  await page.pick('Concentración');
  const desk = page.desk()!;
  assert.ok(desk, 'the writing desk is in the page');
  assert.equal(page.editor()!.value, read(h.bookDir, SCENE), 'the first scene opens in the editor');
  assert.deepEqual(page.texts(desk, 'h2'), ['La puerta de Sal'], 'the scene title is its first heading');
  assert.match(page.texts(desk, 'p').join('|'), /\b\d+ palabras\b/, 'with its word count');
  const picker = all(desk, (n) => n.tagName === 'SELECT')[0];
  assert.equal(picker.attrs['aria-label'], 'Escena');
  assert.deepEqual(picker.children.map((o) => o.textContent), ['escena-01', 'escena-02']);
  assert.equal(page.button('‹ Anterior', desk).disabled, true, 'nothing before the first scene');
  assert.equal(page.help()?.children.length ?? 0, 0, 'no proposal, finding or claim is shown');
  assert.equal(all(desk, (n) => n.tagName === 'ARTICLE').length, 0);
  assert.equal(page.gets.filter((path) => path.includes('/engine')).length, 0, 'nothing is analysed');
});

test('switching modes keeps the same editor, its unsaved text and its selection', async (t) => {
  const { page } = await quietPage(t);
  await page.pick('Concentración');
  const area = page.editor()!;
  const mine = area.value + 'Sin guardar.\n';
  await page.type(mine);
  area.setSelectionRange(10, 14);
  for (const mode of ['Ayuda RE;write', 'Revisión', 'Concentración', 'Ayuda RE;write']) {
    await page.pick(mode);
    assert.equal(page.editor(), area, `${mode}: the editor is the same element, never rebuilt`);
    assert.equal(area.value, mine);
    assert.deepEqual(area.selection, [10, 14]);
  }
  assert.ok([...page.storage.keys()].some((key) => key.startsWith('rewrite:draft:')), 'the unsaved text is still kept in this tab');
});

test('Ayuda RE;write lists the pending work of the open scene only, with its actions', async (t) => {
  let mine = '';
  const { h, page } = await quietPage(t, (h) => {
    cli('extract', h.bookDir, '--from', join(FIXTURES, 'annotations.json'));
    mine = proposeRevision(h.bookDir, SCENE, 'once años', 'doce años', 'Edad de Elena');
    proposeRevision(h.bookDir, OTHER, 'una vela casi consumida', 'una vela nueva', 'Otra escena');
  });
  await page.pick('Ayuda RE;write');
  const help = page.help()!;
  assert.equal(help.attrs['aria-label'], 'Ayuda para esta escena');
  const text = help.textContent;
  assert.match(text, /Edad de Elena/);
  assert.doesNotMatch(text, /Otra escena/, 'a proposal for another scene is not shown');
  const claims = cli('claims', h.bookDir).json.claims;
  for (const claim of claims) {
    if (claim.source_file === SCENE) assert.match(text, new RegExp(claim.statement.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    else assert.doesNotMatch(text, new RegExp(claim.statement.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
  assert.ok(all(help, (n) => n.tagName === 'BUTTON' && n.textContent === 'Aceptar cambio').length === 1, 'the proposal keeps its decision');
  const tabs = all(page.desk()!, (n) => n.attrs.role === 'group' && n.attrs['aria-label'] === 'Panel')[0];
  const problems = cli('check', h.bookDir).json.findings.filter((f: any) => f.citations.some((c: any) => c.source_file === SCENE));
  const pending = 1 + claims.filter((c: any) => c.source_file === SCENE).length + problems.length;
  assert.deepEqual(tabs.children.map((b) => b.textContent), ['Texto', `Ayuda (${pending})`], 'on a phone the help is one tab away, with its count');

  // Rejecting from the column decides it and keeps the editor.
  const area = page.editor();
  await page.click('Rechazar', all(help, (n) => n.tagName === 'ARTICLE' && /Edad de Elena/.test(n.textContent))[0]);
  assert.equal(cli('show', h.bookDir, mine).json.proposal.status, 'rejected');
  assert.match(page.help()!.textContent, /Decisión guardada/, 'the card stays, with the way back');
  assert.equal(page.editor(), area, 'deciding re-renders the review, never the editor');
});

test('a quote in Ayuda selects its text in the editor, and says so when it is no longer there', async (t) => {
  const { page } = await quietPage(t, (h) => cli('extract', h.bookDir, '--from', join(FIXTURES, 'annotations.json')));
  await page.pick('Ayuda RE;write');
  const quote = 'Elena llevaba once años custodiando el puente de Sal';
  const block = all(page.help()!, (n) => n.tagName === 'BLOCKQUOTE' && n.textContent === quote)[0];
  assert.ok(block, 'the claim shows its quote');
  assert.equal(block.tabIndex, 0, 'the quote works from the keyboard');
  const area = page.editor()!;
  await block.events.click();
  await page.settle();
  const start = area.value.indexOf(quote);
  assert.deepEqual(area.selection, [start, start + quote.length]);
  assert.equal(document.activeElement, area);

  await page.type(area.value.replace(quote, 'Elena llevaba años en el puente'));
  await all(page.help()!, (n) => n.tagName === 'BLOCKQUOTE' && n.textContent === quote)[0].events.click();
  await page.settle();
  assert.match(page.help()!.textContent, /No se encuentra la cita en el texto del editor/);
});

test('Ayuda names the version each finding, claim and pending change was read from', async (t) => {
  let proposedAt = '';
  let changeAt = '';
  const { page } = await quietPage(t, (h) => {
    cli('extract', h.bookDir, '--from', join(FIXTURES, 'annotations.json'));
    proposedAt = git(h.bookDir, 'rev-parse', 'HEAD').slice(0, 10);
    Project.open(h.bookDir).proposeFindings([{
      question: 'motivation', kind: 'fact', statement: 'Elena custodia el puente.',
      evidence: [{ file: SCENE, quote: 'Elena llevaba once años custodiando el puente de Sal' }],
    }], 'assistant_ophelia');
    changeAt = git(h.bookDir, 'rev-parse', 'HEAD').slice(0, 10);
    proposeRevision(h.bookDir, SCENE, 'once años', 'doce años', 'Edad de Elena');
  });
  await page.pick('Ayuda RE;write');
  const metas = page.texts(page.help()!, 'p');
  assert.ok(metas.some((m) => m.endsWith('evidencia: válida · versión ' + proposedAt)),
    'the narrative finding names the version its quote was read from: ' + metas.join(' | '));
  assert.ok(metas.some((m) => /narrated_fact · evidencia: valid · .*versión [0-9a-f]{10}$/.test(m)), 'the claim names its version');
  assert.ok(metas.some((m) => /momento de la historia: 1 · evidencia: valid · versión [0-9a-f]{10}$/.test(m)), 'a continuity citation names its version');
  assert.ok(metas.includes('Propuesto sobre la versión ' + changeAt + ' de la escena.'), 'the pending change names the version it was written against');
});

test('the background refresh updates the review but never the editor, and says when the scene changed elsewhere', async (t) => {
  const { h, session, page } = await quietPage(t);
  await page.pick('Ayuda RE;write');
  const area = page.editor()!;
  const mine = area.value + 'Mío.\n';
  await page.type(mine);
  area.focus();
  proposeRevision(h.bookDir, SCENE, 'once años', 'doce años', 'Nueva propuesta');
  await page.poll();
  assert.match(page.help()!.textContent, /Nueva propuesta/, 'news reaches the help column while the person writes');
  assert.equal(page.editor(), area);
  assert.equal(area.value, mine);
  assert.equal(page.desk()!.textContent.includes('cambiado fuera de este editor'), false);

  const path = `/books/sal/scenes/${encodeURIComponent(SCENE)}`;
  const scene = await (await reviewApi(h, path, session)).json();
  assert.equal((await reviewApi(h, path, session, { base_blob: scene.blob, text: scene.text + 'De otra pestaña.\n' })).status, 200);
  await page.poll();
  assert.match(page.desk()!.textContent, /Esta escena ha cambiado fuera de este editor/);
  assert.equal(area.value, mine, 'the person\'s text is untouched');
});

test('previous and next open the neighbour scene, and unsaved text stays as a draft', async (t) => {
  const { h, page } = await quietPage(t);
  await page.pick('Concentración');
  await page.type(page.editor()!.value + 'Borrador.\n');
  await page.click('Siguiente ›', page.desk()!);
  assert.equal(page.editor()!.value, read(h.bookDir, OTHER));
  assert.equal(page.button('Siguiente ›', page.desk()!).disabled, true);
  await page.click('‹ Anterior', page.desk()!);
  assert.match(page.editor()!.value, /Borrador\.\n$/, 'coming back restores the draft');
});

test('the mode switch sits under the thumb on a phone, and nothing it covers is lost', () => {
  const css = REVIEW_CSS.replace(/\/\*[\s\S]*?\*\//g, '');
  const phone = css.slice(css.indexOf('@media (max-width: 40em)'));
  const rule = (source: string, selector: string) => new RegExp(`(?:^|\\})\\s*${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{([^}]*)\\}`).exec(source)?.[1] ?? '';
  const dock = rule(phone, '.mode-switch');
  assert.match(dock, /position:\s*fixed/);
  assert.match(dock, /bottom:\s*0/);
  assert.match(dock, /env\(safe-area-inset-bottom\)/);
  assert.match(rule(phone, 'body[data-mode] .decision'), /bottom:\s*var\(--dock-h\)/, 'a sticky decision bar stops above it');
  assert.match(rule(phone, 'body[data-mode] .assistant-fab'), /var\(--dock-h\)/, 'the assistant button floats above it');
  assert.match(rule(css, '.mode-switch > button'), /min-height:\s*var\(--tap\)/);
  assert.match(rule(css, '.desk'), /display:\s*none/, 'the desk is hidden until a writing mode is chosen');
});

test('Analizar in Ayuda shows its scope before sending, and without the engine says how to get the assistant', async (t) => {
  const { h, page } = await quietPage(t);
  await page.pick('Ayuda RE;write');
  const desk = page.desk()!;
  const box = () => all(desk, (n) => n.attrs['aria-label'] === 'Analizar' && n.tagName === 'SECTION')[0];
  assert.equal(box().hidden, true, 'nothing is shown, let alone sent, before the person asks');
  await page.click('Analizar', desk);
  assert.equal(page.button('Analizar', desk).attrs['aria-expanded'], 'true');
  const words = (read(h.bookDir, SCENE).match(/[\p{L}\p{N}]+(?:['’-][\p{L}\p{N}]+)*/gu) ?? []).length;
  const line = () => all(box(), (n) => n.className === 'analyse-scope')[0].textContent;
  assert.equal(line(), `Se analizará: escena 01 (${new Intl.NumberFormat('es', { useGrouping: 'always' }).format(words)} palabras)`);
  assert.equal(page.button('Esta escena', box()).attrs['aria-pressed'], 'true', 'the scene is the scope by default');

  // Unsaved text is not what the assistant reads: the scope says so.
  await page.type(page.editor()!.value + 'Sin guardar.\n');
  await page.click('Esta escena', box());
  assert.equal(line(), `Se analizará: escena 01 (${new Intl.NumberFormat('es', { useGrouping: 'always' }).format(words)} palabras)`, 'it counts the saved text the assistant reads');
  assert.match(page.texts(box(), 'p').join('|'), /tus cambios sin guardar no entran/);

  await page.click('La selección', box());
  assert.equal(line(), 'Selecciona un fragmento en el texto para analizarlo.');
  assert.equal(page.button('Enviar al asistente', box()).disabled, true, 'no selection, nothing to send');
  const area = page.editor()! as any;
  const at = area.value.indexOf('Elena llevaba');
  area.selectionStart = at;
  area.selectionEnd = at + 'Elena llevaba'.length;
  await page.click('La selección', box());
  assert.equal(line(), 'Se analizará: la selección de escena 01 (2 palabras)');

  await page.click('El libro', box());
  assert.equal(line(), 'Se analizará: el libro «La puerta de Sal» (2 escenas)');
  assert.equal(page.button('Enviar al asistente', box()).disabled, false);

  await page.click('Enviar al asistente', box());
  assert.match(page.texts(box(), 'p').join('|'), /El asistente no está activado en este servidor\. Tu cuenta de RE;write basta para escribir y revisar/);
  assert.equal(page.gets.filter((path) => path.includes('/engine')).length, 0, 'no engine path is asked');
  assert.equal(page.editor()!.value.endsWith('Sin guardar.\n'), true, 'the text is untouched');
});

// --- Libro: the book tree drawer (docs/book-structure.md) -----------------------------------------

const words = (text: string) => (text.match(/[\p{L}\p{N}]+(?:['’-][\p{L}\p{N}]+)*/gu) ?? []).length;
const grouped = (n: number) => new Intl.NumberFormat('es', { useGrouping: 'always' }).format(n);

/** Drives the drawer: finds controls by the accessible name the person hears. */
async function treePage(t: any, setup?: (h: Harness) => void) {
  const ctx = await quietPage(t, setup);
  await ctx.page.pick('Concentración');
  const tree = () => document.getElementById('desk-tree') as Element;
  const named = (label: string) => {
    const found = all(tree(), (n) => n.attrs['aria-label'] === label && shown(n));
    assert.equal(found.length, 1, `one "${label}" control`);
    return found[0];
  };
  const press = async (label: string) => { await named(label).events.click(); await ctx.page.settle(); };
  const fill = async (label: string, value: string) => {
    const field = named(label);
    field.value = value;
    await field.events.input?.();
  };
  const text = () => tree().textContent;
  const status = () => all(tree(), (n) => n.attrs.role === 'status')[0].textContent;
  const opened = async () => { await ctx.page.click('Índice', ctx.page.desk()!); };
  return { ...ctx, tree, named, press, fill, text, status, opened };
}

test('Libro is closed until asked, then shows chapters, scenes, word counts, the total and the open scene', async (t) => {
  const { h, page, tree, opened, text } = await treePage(t);
  assert.equal(tree().hidden, true, 'the drawer starts closed');
  assert.equal(page.button('Índice', page.desk()!).attrs['aria-expanded'], 'false');
  await opened();
  assert.equal(tree().hidden, false);
  assert.equal(page.button('Índice', page.desk()!).attrs['aria-expanded'], 'true');
  const a = words(read(h.bookDir, SCENE));
  const b = words(read(h.bookDir, OTHER));
  assert.match(text(), new RegExp(`Libro: ${grouped(a + b)} palabras`));
  const names = all(tree(), (n) => n.className === 'tree-name');
  assert.deepEqual(names.map((n) => n.textContent), ['La puerta de Sal', 'El altar'], 'titles from the first heading');
  assert.deepEqual(names.map((n) => n.attrs['aria-current'] ?? null), ['true', null], 'the open scene is marked');
  const counts = all(tree(), (n) => n.className === 'meta tree-words').map((n) => n.textContent);
  assert.deepEqual(counts, [`${grouped(a)} palabras`, `${grouped(b)} palabras`]);
});

test('Libro: a chapter, a scene in it, a new title, archive and restore: each is one commit and the page follows', async (t) => {
  const { h, page, tree, named, press, fill, text, status } = await treePage(t);
  const commits = () => Number(git(h.bookDir, 'rev-list', '--count', 'HEAD'));
  const project = () => Project.open(h.bookDir);
  const submit = async (label: string) => { await page.click(label, tree()); };
  await page.click('Índice', page.desk()!);

  let before = commits();
  await page.click('Nuevo capítulo', tree());
  await fill('Título del nuevo capítulo', 'Primera parte');
  await submit('Crear capítulo');
  assert.equal(commits(), before + 1);
  assert.deepEqual(project().outline().chapters.map((c) => c.title), ['Primera parte']);
  assert.match(text(), /Primera parte/);

  before = commits();
  await page.click('Nueva escena', tree());
  await fill('Título de la nueva escena', 'Llegada');
  named('Capítulo').value = project().outline().chapters[0].id;
  await submit('Crear escena');
  assert.equal(commits(), before + 1);
  assert.equal(read(h.bookDir, 'scenes/llegada.md'), '# Llegada\n');
  assert.deepEqual(project().scenes(), ['scenes/llegada.md', SCENE, OTHER]);
  assert.equal(page.editor()!.value, '# Llegada\n', 'the new scene opens in the editor');
  const current = all(tree(), (n) => n.attrs['aria-current'] === 'true').map((n) => n.textContent);
  assert.deepEqual(current, ['Llegada']);
  const picker = all(page.desk()!, (n) => n.tagName === 'SELECT' && n.attrs['aria-label'] === 'Escena')[0];
  assert.deepEqual(picker.children.map((o) => o.value), ['scenes/llegada.md', SCENE, OTHER], 'the scene picker follows book order');

  before = commits();
  await press('Renombrar «Llegada»');
  await fill('Nuevo título de la escena', 'La llegada');
  await submit('Renombrar');
  assert.equal(commits(), before + 1);
  assert.equal(project().outline().chapters[0].scenes[0].title, 'La llegada');
  assert.equal(read(h.bookDir, 'scenes/llegada.md'), '# Llegada\n', 'the file keeps its path and its text');

  before = commits();
  await press('Archivar «El altar»');
  assert.equal(commits(), before + 1);
  assert.deepEqual(project().scenes(), ['scenes/llegada.md', SCENE]);
  assert.deepEqual(project().archivedScenes(), [OTHER]);
  assert.match(text(), /Archivo \(1\)/);
  assert.doesNotMatch(text(), /Restaurar/, 'the archive is folded until asked');
  await page.click('Archivo (1)', tree());
  await press('Restaurar «El altar»');
  assert.deepEqual(project().scenes(), ['scenes/llegada.md', SCENE, OTHER]);
  assert.equal(status(), '');
});

test('Libro: scenes and chapters reorder from the keyboard with the focus kept on the control that was used', async (t) => {
  const { h, page, tree, named, press, fill, text } = await treePage(t);
  const scenes = () => Project.open(h.bookDir).scenes();
  await page.click('Índice', page.desk()!);
  await press('Bajar «La puerta de Sal»');
  assert.deepEqual(scenes(), [OTHER, SCENE]);
  assert.equal(document.activeElement, named('Bajar «La puerta de Sal»'), 'the focus stays on the same control');
  await press('Subir «La puerta de Sal»');
  assert.deepEqual(scenes(), [SCENE, OTHER]);
  assert.equal(document.activeElement, named('Subir «La puerta de Sal»'));

  // A chapter is made from the keyboard alone: Enter in the title field creates it.
  await page.click('Nuevo capítulo', tree());
  await fill('Título del nuevo capítulo', 'Uno');
  await named('Título del nuevo capítulo').events.keydown({ key: 'Enter', preventDefault() {} });
  await page.settle();
  assert.deepEqual(Project.open(h.bookDir).outline().chapters.map((c) => c.title), ['Uno']);
  const chapter = Project.open(h.bookDir).outline().chapters[0].id;

  // "Mover a" carries a scene into a chapter; the arrows then keep it inside, and past the edge into the next group.
  const move = named('Mover «La puerta de Sal» a');
  move.value = chapter;
  await move.events.change();
  await page.settle();
  assert.deepEqual(Project.open(h.bookDir).outline().chapters[0].scenes.map((s) => s.file), [SCENE]);
  assert.deepEqual(scenes(), [SCENE, OTHER]);
  await press('Bajar «La puerta de Sal»');
  assert.deepEqual(Project.open(h.bookDir).outline().chapters[0].scenes, [], 'down from the last place of a chapter leaves it');
  assert.deepEqual(scenes(), [SCENE, OTHER]);
  assert.match(text(), /Capítulo vacío/);
  await press('Quitar el capítulo vacío «Uno»');
  assert.deepEqual(Project.open(h.bookDir).outline().chapters, []);
});

test('Libro: dragging a scene before another one reorders it', async (t) => {
  const { h, page, tree } = await treePage(t);
  await page.click('Índice', page.desk()!);
  const [first, second] = all(tree(), (n) => /^tree-scene( |$)/.test(n.className));
  await second.events.dragstart({ dataTransfer: { effectAllowed: '', setData() {} } });
  let prevented = false;
  await first.events.dragover({ preventDefault() { prevented = true; } });
  assert.equal(prevented, true, 'a scene can be dropped on a scene');
  await first.events.drop({ preventDefault() {}, stopPropagation() {} });
  await page.settle();
  assert.deepEqual(Project.open(h.bookDir).scenes(), [OTHER, SCENE]);
});

test('Libro: switching scenes from the tree never loses unsaved text', async (t) => {
  const { h, page, tree } = await treePage(t);
  await page.click('Índice', page.desk()!);
  const mine = page.editor()!.value + 'Escrito y sin guardar.\n';
  await page.type(mine);
  const go = async (title: string) => {
    const name = all(tree(), (n) => n.className === 'tree-name' && n.textContent === title)[0];
    await name.events.click();
    await page.settle();
  };
  await go('El altar');
  assert.equal(page.editor()!.value, read(h.bookDir, OTHER), 'the other scene opens');
  assert.ok([...page.storage.keys()].some((key) => key.startsWith('rewrite:draft:') && key.endsWith(SCENE)), 'the text left behind is kept as its draft');
  await go('La puerta de Sal');
  assert.equal(page.editor()!.value, mine, 'coming back, the unsaved text is still there');
  assert.equal(read(h.bookDir, SCENE).endsWith('Escrito y sin guardar.\n'), false, 'and nothing was saved behind the back');
});

test('Libro: a change based on an older book is refused, the tree reloads and says so', async (t) => {
  const { h, page, text, status, fill, tree } = await treePage(t);
  await page.click('Índice', page.desk()!);
  const project = Project.open(h.bookDir);
  project.editStructure(project.outline().version, { op: 'create_chapter', title: 'Desde otra pestaña' }, 'otra');
  const before = Number(git(h.bookDir, 'rev-list', '--count', 'HEAD'));
  await page.click('Nuevo capítulo', tree());
  await fill('Título del nuevo capítulo', 'Tarde');
  await page.click('Crear capítulo', tree());
  assert.equal(Number(git(h.bookDir, 'rev-list', '--count', 'HEAD')), before, 'nothing was written');
  assert.match(status(), /El libro cambió desde que lo abriste/);
  assert.match(status(), /Se ha vuelto a cargar/);
  assert.match(text(), /Desde otra pestaña/);
});

test('Libro: an archived scene stays openable and is named in the picker; the tree is a drawer over the text', async (t) => {
  const { h, page, tree, press } = await treePage(t);
  await page.click('Índice', page.desk()!);
  await press('Archivar «La puerta de Sal»');
  assert.equal(page.editor()!.value, read(h.bookDir, OTHER), 'archiving the open scene opens the next one');
  await page.click('Archivo (1)', tree());
  const archived = all(tree(), (n) => n.className === 'tree-name' && n.textContent === 'La puerta de Sal')[0];
  await archived.events.click();
  await page.settle();
  assert.equal(page.editor()!.value, read(h.bookDir, SCENE), 'an archived scene opens by path');
  const picker = all(page.desk()!, (n) => n.tagName === 'SELECT' && n.attrs['aria-label'] === 'Escena')[0];
  assert.deepEqual(picker.children.map((o) => o.textContent), ['Archivo: escena-01', 'escena-02']);
  assert.match(REVIEW_CSS, /\.desk-tree \{ position: fixed;/, 'the tree is a drawer over the text');
});

// ---- Libro: the whole manuscript to read, and the writing goals (docs/design.md, "Modes") ----

const countWords = (text: string) => (text.match(/[\p{L}\p{N}]+(?:['’-][\p{L}\p{N}]+)*/gu) ?? []).length;
const localDay = () => {
  const now = new Date();
  const two = (n: number) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${two(now.getMonth() + 1)}-${two(now.getDate())}`;
};
/** Lets the page's pending requests finish (they use the real server, not the fake timers). */
async function until(page: { settle: () => Promise<void> }, done: () => boolean) {
  for (let round = 0; round < 200 && !done(); round++) {
    await new Promise((resolve) => setTimeout(resolve, 10));
    await page.settle();
  }
  assert.ok(done(), 'the page got there');
}
const place = () => document.getElementById('book') as Element;
const sections = () => place() ? all(place(), (n) => n.className === 'book-scene') : [];
const goalsText = () => all(place(), (n) => n.className === 'book-goals')[0]?.textContent ?? '';
const footerText = () => all(document.getElementById('desk') as Element, (n) => n.className === 'meta desk-goals')[0]?.textContent ?? '';

test('Libro is a fourth place in the switch, remembered per person, and the other three behave as before', async (t) => {
  const { h, session, page } = await quietPage(t);
  assert.deepEqual(Object.keys(page.switchState()), ['Concentración', 'Ayuda RE;write', 'Libro', 'Revisión']);
  await page.pick('Libro');
  assert.equal(page.mode(), 'book');
  assert.deepEqual(page.switchState(), { 'Concentración': 'false', 'Ayuda RE;write': 'false', 'Libro': 'true', 'Revisión': 'false' });
  assert.equal(page.local.get(`rewrite:mode:${personOf(session)}`), 'book');
  await until(page, () => sections().length === 2);

  const again = await openPage(h, session, page.local);
  await until(again, () => sections().length === 2);
  assert.equal(again.mode(), 'book', 'a reload comes back to Libro');

  // The three older modes keep their own behaviour around it.
  await again.pick('Concentración');
  assert.equal(again.mode(), 'focus');
  assert.equal(again.editor()?.value, read(h.bookDir, SCENE));
  await again.pick('Ayuda RE;write');
  assert.equal(again.help()?.attrs['aria-label'], 'Ayuda para esta escena');
  await again.pick('Revisión');
  assert.equal(again.mode(), 'review');
  assert.deepEqual(again.switchState(), { 'Concentración': 'false', 'Ayuda RE;write': 'false', 'Libro': 'false', 'Revisión': 'true' });
});

test('Libro shows every scene in book order with a heading, a scene break, a contents with counts and the total', async (t) => {
  const { h, page } = await quietPage(t);
  await page.pick('Libro');
  await until(page, () => sections().length === 2);
  const files = Project.open(h.bookDir).scenes();
  const texts = files.map((file) => read(h.bookDir, file));
  assert.deepEqual(sections().map((s) => all(s, (n) => n.tagName === 'H3')[0].textContent), ['Escena 01', 'Escena 02']);
  assert.match(sections()[0].textContent, /La puerta de Sal/);
  assert.equal(all(place(), (n) => n.attrs.role === 'separator').length, 1, 'one scene break between two scenes');
  const prose = all(sections()[0], (n) => n.className === 'book-prose')[0];
  assert.ok(all(prose, (n) => n.tagName === 'P').every((p) => !/^#/.test(p.textContent)), 'Markdown headings are not shown as raw marks');
  assert.ok(prose.textContent.includes('Elena llevaba once años custodiando el puente de Sal'));

  const toc = all(place(), (n) => n.tagName === 'NAV')[0];
  assert.equal(toc.attrs['aria-label'], 'Contenido del libro');
  const items = all(toc, (n) => n.tagName === 'BUTTON').map((b) => b.textContent);
  assert.equal(items.length, files.length);
  for (let i = 0; i < files.length; i++) assert.ok(items[i].endsWith(grouped(countWords(texts[i]))), `scene ${i + 1} shows its count`);
  const total = texts.reduce((n, text) => n + countWords(text), 0);
  assert.equal(all(toc, (n) => n.className === 'book-toc-total')[0].textContent, `Total del libro: ${grouped(total)} palabras`);
  assert.equal(page.gets.filter((path) => path.endsWith('/manuscript')).length, 1, 'the whole book arrives in one request');
  assert.equal(page.gets.filter((path) => path.includes('/scenes/')).length, 0, 'no scene is read one by one');
});

test('Libro shows each chapter as a heading in the text and in the contents', async (t) => {
  const { page } = await quietPage(t, (h) => {
    const project = Project.open(h.bookDir);
    const second = project.scenes()[1];
    project.editStructure(project.outline().version, { op: 'create_chapter', title: 'Primera parte' }, 'user_fran');
    project.editStructure(project.outline().version, { op: 'move_scene', file: second, chapter: project.outline().chapters[0].id }, 'user_fran');
  });
  await page.pick('Libro');
  await until(page, () => sections().length === 2);
  const chapters = all(place(), (n) => n.className === 'book-chapter');
  assert.deepEqual(chapters.map((n) => n.textContent), ['Primera parte'], 'one heading, before its first scene');
  const toc = all(place(), (n) => n.tagName === 'NAV')[0];
  assert.deepEqual(all(toc, (n) => n.className === 'book-toc-chapter').map((n) => n.textContent), ['Primera parte']);
  assert.equal(all(toc, (n) => n.tagName === 'BUTTON').length, 2, 'scenes stay the only buttons');
});

test('Libro: a scene in the contents scrolls to it and takes the focus; the drawer is a keyboard-operable disclosure', async (t) => {
  const { page } = await quietPage(t);
  await page.pick('Libro');
  await until(page, () => sections().length === 2);
  const toc = all(place(), (n) => n.tagName === 'NAV')[0];
  const toggle = page.button('Contenido', place());
  assert.equal(toggle.attrs['aria-expanded'], 'false');
  assert.equal(toggle.attrs['aria-controls'], toc.id);
  await toggle.events.click();
  assert.equal(toggle.attrs['aria-expanded'], 'true');
  assert.equal(place().attrs['data-toc'], 'open');
  place().events.keydown({ key: 'Escape' });
  assert.equal(toggle.attrs['aria-expanded'], 'false', 'Escape closes the drawer');
  assert.equal(document.activeElement, toggle, 'and gives the focus back');

  await toggle.events.click();
  scrolled.length = 0;
  const second = all(toc, (n) => n.tagName === 'BUTTON')[1];
  assert.equal(second.tagName, 'BUTTON', 'a native button: Enter and Space click it');
  await second.events.click();
  assert.deepEqual(scrolled, [sections()[1]], 'the second scene is scrolled to');
  assert.equal(document.activeElement, all(sections()[1], (n) => n.tagName === 'H3')[0], 'its heading has the focus');
  assert.equal(toggle.attrs['aria-expanded'], 'false', 'choosing a scene closes the drawer');
});

test('Escribir aquí opens that scene in the desk, in the last writing mode, with the caret at its start', async (t) => {
  const { h, page } = await quietPage(t);
  await page.pick('Ayuda RE;write');
  await page.pick('Libro');
  await until(page, () => sections().length === 2);
  await page.click('Escribir aquí', sections()[1]);
  assert.equal(page.mode(), 'help', 'back in the mode that was last used for writing');
  await until(page, () => page.editor()?.value === read(h.bookDir, OTHER));
  assert.deepEqual((page.editor() as Element).selection, [0, 0], 'the caret is at the start of the scene');
  assert.equal(document.activeElement, page.editor());

  await page.pick('Concentración');
  await page.pick('Libro');
  await page.click('Escribir aquí', sections()[0]);
  assert.equal(page.mode(), 'focus');
  await until(page, () => page.editor()?.value === read(h.bookDir, SCENE));
});

test('unsaved text in the desk survives a trip to Libro, which shows it as the person\'s version and writes nothing', async (t) => {
  const { h, page } = await quietPage(t);
  await page.pick('Concentración');
  const area = page.editor()!;
  const mine = area.value + 'Frase nueva sin guardar.\n';
  await page.type(mine);
  const head = git(h.bookDir, 'rev-parse', 'HEAD');
  await page.pick('Libro');
  await until(page, () => sections().length === 2);
  assert.match(sections()[0].textContent, /Sin guardar: se muestra tu versión/);
  assert.match(sections()[0].textContent, /Frase nueva sin guardar\./);
  assert.doesNotMatch(sections()[1].textContent, /Sin guardar/, 'only the scene with unsaved text is marked');
  assert.match(all(place(), (n) => n.className === 'book-toc-flag')[0].textContent, /sin guardar/);

  await page.pick('Concentración');
  assert.equal(page.editor(), area, 'the editor is the same element');
  assert.equal(area.value, mine, 'with the text as it was');
  await page.pick('Libro');
  await page.click('Escribir aquí', sections()[0]);
  assert.equal(page.editor(), area, 'Escribir aquí on the open scene keeps its editor');
  assert.equal(area.value, mine);
  assert.deepEqual(area.selection, [0, 0]);
  assert.equal(git(h.bookDir, 'rev-parse', 'HEAD'), head, 'nothing was committed');
});

test('goals: stored per person and book, shown in Libro and in the desk, and today counts saved words only', async (t) => {
  const { h, session, page } = await quietPage(t);
  const texts = Project.open(h.bookDir).scenes().map((file) => read(h.bookDir, file));
  const total = texts.reduce((n, text) => n + countWords(text), 0);
  const person = personOf(session);
  await page.pick('Libro');
  await until(page, () => /hoy/.test(goalsText()));
  assert.equal(goalsText(), `${grouped(total)} palabras · hoy +0`, 'the first reading of the day is the baseline');
  assert.deepEqual(JSON.parse(page.local.get(`rewrite:goals-day:${person}:sal`)!), { date: localDay(), total });
  assert.match(all(place(), (n) => n.className === 'book-goals')[0].title, /solo el texto guardado/, 'it says only saved text counts');

  const [bookGoal, dayGoal] = all(place(), (n) => n.tagName === 'INPUT');
  bookGoal.value = '80000';
  await bookGoal.events.change();
  dayGoal.value = '500';
  await dayGoal.events.change();
  assert.equal(goalsText(), `${grouped(total)} / 80.000 palabras · hoy +0 / 500`);
  assert.deepEqual(JSON.parse(page.local.get(`rewrite:goals:${person}:sal`)!), { book: 80000, day: 500 });

  await page.pick('Concentración');
  await until(page, () => footerText() !== '');
  assert.equal(footerText(), `${grouped(total)} / 80.000 palabras · hoy +0 / 500`, 'the desk footer shows the same line');

  // Saved words add to today; unsaved ones do not.
  await page.type(page.editor()!.value + 'uno dos tres\n');
  assert.equal(footerText(), `${grouped(total)} / 80.000 palabras · hoy +0 / 500`);
  await page.click('Guardar', page.desk()!);
  await until(page, () => footerText().includes('hoy +3'));
  assert.equal(footerText(), `${grouped(total + 3)} / 80.000 palabras · hoy +3 / 500`);

  // A reload keeps the targets and the day's baseline; another person starts clean.
  const again = await openPage(h, session, page.local);
  await again.pick('Libro');
  await until(again, () => /hoy/.test(goalsText()));
  assert.equal(goalsText(), `${grouped(total + 3)} / 80.000 palabras · hoy +3 / 500`);
  const stranger = await openPage(h, await h.session('user_other'), page.local);
  assert.equal(stranger.local.get(`rewrite:goals:${personOf(await h.session('user_other'))}:sal`), undefined);
});

test('goals: a baseline from an earlier day is replaced, one from today is kept, and a shrinking book shows a minus', async (t) => {
  const { h, session } = await quietPage(t);
  const total = Project.open(h.bookDir).scenes().reduce((n, file) => n + countWords(read(h.bookDir, file)), 0);
  const key = `rewrite:goals-day:${personOf(session)}:sal`;

  const old = new Map([[key, JSON.stringify({ date: '2001-02-03', total: 1 })]]);
  const next = await openPage(h, session, new Map([...old, [`rewrite:mode:${personOf(session)}`, 'book']]));
  await until(next, () => /hoy/.test(goalsText()));
  assert.equal(goalsText(), `${grouped(total)} palabras · hoy +0`, 'a new day starts from the saved total');
  assert.deepEqual(JSON.parse(next.local.get(key)!), { date: localDay(), total });

  const today = new Map([[key, JSON.stringify({ date: localDay(), total: total - 100 })], [`rewrite:mode:${personOf(session)}`, 'book']]);
  const same = await openPage(h, session, today);
  await until(same, () => /hoy/.test(goalsText()));
  assert.equal(goalsText(), `${grouped(total)} palabras · hoy +100`);

  const more = new Map([[key, JSON.stringify({ date: localDay(), total: total + 2000 })], [`rewrite:mode:${personOf(session)}`, 'book']]);
  const fewer = await openPage(h, session, more);
  await until(fewer, () => /hoy/.test(goalsText()));
  assert.equal(goalsText(), `${grouped(total)} palabras · hoy −${grouped(2000)}`);
});

// --- Esquema view inside Libro -------------------------------------------------------------

const outlineBox = () => all(place(), (n) => n.className === 'book-outline')[0];
const outlineRows = () => outlineBox() ? all(outlineBox(), (n) => /^outline-row( |$)/.test(n.className)) : [];

test('Esquema: the Leer/Esquema toggle is remembered per person in this browser', async (t) => {
  const { h, session, page } = await quietPage(t);
  const person = personOf(session);
  await page.pick('Libro');
  await until(page, () => sections().length === 2);

  const leerBtn = page.button('Leer', place());
  const esquemaBtn = page.button('Esquema', place());
  assert.equal(leerBtn.attrs['aria-pressed'], 'true');
  assert.equal(esquemaBtn.attrs['aria-pressed'], 'false');
  assert.equal(outlineBox().hidden, true);

  await page.click('Esquema', place());
  assert.equal(leerBtn.attrs['aria-pressed'], 'false');
  assert.equal(esquemaBtn.attrs['aria-pressed'], 'true');
  assert.equal(outlineBox().hidden, false);
  assert.equal(page.local.get(`rewrite:book-view:${person}`), 'outline');

  // Reload keeps Esquema view
  const again = await openPage(h, session, page.local);
  await again.pick('Libro');
  await until(again, () => outlineRows().length === 2);
  const againLeer = again.button('Leer', place());
  const againEsquema = again.button('Esquema', place());
  assert.equal(againLeer.attrs['aria-pressed'], 'false');
  assert.equal(againEsquema.attrs['aria-pressed'], 'true');
  assert.equal(outlineBox().hidden, false);

  await again.click('Leer', place());
  assert.equal(again.local.get(`rewrite:book-view:${person}`), 'read');
});

test('Esquema: reading view badge appears next to each scene heading', async (t) => {
  const { page } = await quietPage(t);
  await page.pick('Libro');
  await until(page, () => sections().length === 2);

  const badges = all(place(), (n) => n.className.includes('book-scene-status'));
  assert.equal(badges.length, 2);
  assert.equal(badges[0].textContent, 'Borrador');
  assert.equal(badges[1].textContent, 'Borrador');
});

test('Esquema: rows in book order under chapter headings, with totals and Terminado count', async (t) => {
  const { h, page } = await quietPage(t);
  const project = Project.open(h.bookDir);
  const [first, second] = project.scenes();
  const step = (op: any) => project.editStructure(project.outline().version, op, 'user_fran');
  step({ op: 'create_chapter', title: 'Capítulo 1' });
  step({ op: 'move_scene', file: first, chapter: project.outline().chapters[0].id });
  step({ op: 'set_status', file: first, status: 'final' });

  await page.pick('Libro');
  await page.click('Esquema', place());
  await until(page, () => outlineRows().length === 2);

  const titles = all(outlineBox(), (n) => n.className === 'outline-title').map((n) => n.textContent);
  assert.deepEqual(titles, ['La puerta de Sal', 'El altar']);

  // Chapter heading and counters
  const chapterMeta = all(outlineBox(), (n) => n.className.includes('outline-chapter-meta'))[0];
  assert.ok(chapterMeta);
  assert.match(chapterMeta.textContent, /1 terminada/);

  // Book total
  const bookMeta = all(outlineBox(), (n) => n.className.includes('outline-total'))[0];
  assert.ok(bookMeta);
  assert.match(bookMeta.textContent, /palabras/);
});

test('Esquema: inline synopsis edit saves on Enter and cancels on Escape', async (t) => {
  const { h, page } = await quietPage(t);
  await page.pick('Libro');
  await page.click('Esquema', place());
  await until(page, () => outlineRows().length === 2);

  const row = outlineRows()[0];
  const input = all(row, (n) => n.tagName === 'INPUT' && n.className.includes('outline-synopsis'))[0];
  assert.ok(input);
  assert.equal(input.value, '');

  const commitsBefore = Number(git(h.bookDir, 'rev-list', '--count', 'HEAD'));
  input.value = 'Primera sinopsis';
  await input.events.keydown?.({ key: 'Enter', preventDefault() {} });
  await until(page, () => Number(git(h.bookDir, 'rev-list', '--count', 'HEAD')) === commitsBefore + 1);

  const p = Project.open(h.bookDir);
  assert.equal(p.outline().loose[0].synopsis, 'Primera sinopsis');

  // Escape cancels edit
  const currentInput = all(outlineRows()[0], (n) => n.tagName === 'INPUT' && n.className.includes('outline-synopsis'))[0];
  assert.equal(currentInput.value, 'Primera sinopsis');
  currentInput.value = 'Cambio cancelado';
  await currentInput.events.keydown?.({ key: 'Escape', preventDefault() {} });
  assert.equal(currentInput.value, 'Primera sinopsis');
  assert.equal(Number(git(h.bookDir, 'rev-list', '--count', 'HEAD')), commitsBefore + 1);
});

test('Esquema: status selector saves', async (t) => {
  const { h, page } = await quietPage(t);
  await page.pick('Libro');
  await page.click('Esquema', place());
  await until(page, () => outlineRows().length === 2);

  const row = outlineRows()[0];
  const select = all(row, (n) => n.tagName === 'SELECT' && n.className.includes('outline-status'))[0];
  assert.ok(select);
  assert.equal(select.value, 'draft');

  const commitsBefore = Number(git(h.bookDir, 'rev-list', '--count', 'HEAD'));
  select.value = 'final';
  await select.events.change?.();
  await until(page, () => Number(git(h.bookDir, 'rev-list', '--count', 'HEAD')) === commitsBefore + 1);

  const p = Project.open(h.bookDir);
  assert.equal(p.outline().loose[0].status, 'final');
});

test('Esquema: filter by status works', async (t) => {
  const { h, page } = await quietPage(t);
  const project = Project.open(h.bookDir);
  const [first] = project.scenes();
  project.editStructure(project.outline().version, { op: 'set_status', file: first, status: 'final' } as any, 'user_fran');

  await page.pick('Libro');
  await page.click('Esquema', place());
  await until(page, () => outlineRows().length === 2);

  // Filter Terminado
  await page.click('Terminado', outlineBox());
  const visibleFinal = outlineRows().filter((r) => !r.hidden);
  assert.equal(visibleFinal.length, 1);
  assert.match(visibleFinal[0].textContent, /La puerta de Sal/);

  // Filter Borrador
  await page.click('Borrador', outlineBox());
  const visibleDraft = outlineRows().filter((r) => !r.hidden);
  assert.equal(visibleDraft.length, 1);
  assert.match(visibleDraft[0].textContent, /El altar/);

  // Filter Todas
  await page.click('Todas', outlineBox());
  const visibleAll = outlineRows().filter((r) => !r.hidden);
  assert.equal(visibleAll.length, 2);
});

test('Esquema: a 409 reloads the outline and a failed save keeps typed synopsis', async (t) => {
  const { h, page } = await quietPage(t);
  await page.pick('Libro');
  await page.click('Esquema', place());
  await until(page, () => outlineRows().length === 2);

  const row = outlineRows()[0];
  const input = all(row, (n) => n.tagName === 'INPUT' && n.className.includes('outline-synopsis'))[0];

  // Out-of-band structure change to cause 409
  const p = Project.open(h.bookDir);
  p.editStructure(p.outline().version, { op: 'create_chapter', title: 'Conflicto' }, 'user_other');

  input.value = 'Sinopsis con conflicto';
  await input.events.keydown?.({ key: 'Enter', preventDefault() {} });
  const status = () => all(outlineBox(), (n) => n.attrs.role === 'status')[0];
  await until(page, () => (status()?.textContent.length ?? 0) > 0);

  // Failed save keeps typed synopsis in the field
  assert.equal(input.value, 'Sinopsis con conflicto');
  assert.match(status().textContent, /volver|cargado|conflicto|cambiado/i);
});
