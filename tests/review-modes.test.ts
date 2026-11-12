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
  scrollIntoView() {}
  focus() { document.activeElement = this; }
  setSelectionRange(start: number, end: number) { this.selection = [start, end]; }
}
let document: any;
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
  assert.deepEqual(page.switchState(), { 'Concentración': 'false', 'Ayuda RE;write': 'false', 'Revisión': 'true' });

  await page.pick('Concentración');
  assert.equal(page.mode(), 'focus');
  assert.deepEqual(page.switchState(), { 'Concentración': 'true', 'Ayuda RE;write': 'false', 'Revisión': 'false' });
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
