/**
 * The assistant panel of the review page, run from the script the server really serves
 * (the review page's script followed by the panel's) against a minimal DOM.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import { ASSISTANT_CSS, ASSISTANT_JS } from '../src/adapters/engine-page.ts';
import { REVIEW_JS } from '../src/adapters/review-page.ts';

class Text {
  textContent: string;
  constructor(text: string) { this.textContent = text; }
}

class Element {
  tagName: string;
  children: (Element | Text)[] = [];
  parent: Element | null = null;
  className = '';
  id = '';
  value = '';
  type = '';
  disabled = false;
  hidden = false;
  tabIndex = 0;
  rows = 0;
  maxLength = 0;
  placeholder = '';
  scrollTop = 0;
  scrollHeight = 0;
  clientHeight = 0;
  isConnected = true;
  scrolled = 0;
  attrs: Record<string, string> = {};
  events: Record<string, Function> = {};
  private doc: FakeDocument;
  constructor(tag: string, doc: FakeDocument) { this.tagName = tag.toUpperCase(); this.doc = doc; }
  get childNodes() { return this.children; }
  set textContent(text: string) { this.children = text ? [new Text(text)] : []; }
  get textContent(): string { return this.children.map((c) => c.textContent).join(''); }
  private adopt(nodes: (Element | Text | string)[]) {
    return nodes.map((n) => {
      if (typeof n === 'string') return new Text(n);
      if (n instanceof Element) n.parent = this;
      return n;
    });
  }
  append(...nodes: (Element | Text | string)[]) { this.children.push(...this.adopt(nodes)); }
  prepend(...nodes: (Element | Text | string)[]) { this.children.unshift(...this.adopt(nodes)); }
  replaceChildren(...nodes: (Element | Text | string)[]) { this.children = this.adopt(nodes); }
  setAttribute(key: string, value: string) { this.attrs[key] = String(value); }
  getAttribute(key: string) { return this.attrs[key] ?? null; }
  hasAttribute(key: string) { return key in this.attrs; }
  addEventListener(event: string, fn: Function) { this.events[event] = fn; }
  focus() { this.doc.activeElement = this; }
  scrollIntoView() { this.scrolled++; }
  getBoundingClientRect() { return { top: 0 }; }
  get offsetParent() { return null; }
  get classList() {
    const list = () => this.className.split(' ').filter(Boolean);
    return {
      add: (name: string) => { this.className = [...new Set([...list(), name])].join(' '); },
      remove: (name: string) => { this.className = list().filter((c) => c !== name).join(' '); },
      toggle: (name: string, on?: boolean) => {
        const has = list().includes(name);
        const next = on === undefined ? !has : on;
        if (next !== has) (next ? this.classList.add(name) : this.classList.remove(name));
        return next;
      },
      contains: (name: string) => list().includes(name),
    };
  }
  matches(selector: string): boolean {
    if (selector.startsWith('#')) return this.id === selector.slice(1);
    if (selector === 'section[id^="sec-"]') return this.tagName === 'SECTION' && this.id.startsWith('sec-');
    if (selector === '[data-item]') return 'data-item' in this.attrs;
    return false;
  }
  closest(selector: string): Element | null {
    for (let node: Element | null = this; node; node = node.parent) if (node.matches(selector)) return node;
    return null;
  }
  querySelectorAll(selector: string): Element[] { return all(this).filter((n) => n.matches(selector)); }
  getElementsByTagName(tag: string): Element[] { return all(this).filter((n) => n.tagName === tag.toUpperCase()); }
}

class FakeDocument {
  activeElement: Element | null = null;
  body: Element;
  app: Element;
  toggle: Element;
  constructor(withAssistant: boolean) {
    this.body = new Element('body', this);
    if (withAssistant) this.body.setAttribute('data-assistant', '');
    this.app = new Element('main', this);
    this.app.id = 'app';
    this.toggle = new Element('button', this);
    this.toggle.id = 'assistant-toggle';
    this.body.append(this.toggle, this.app);
  }
  getElementById(id: string) { return all(this.body).find((n) => n.id === id) ?? null; }
  createElement(tag: string) { return new Element(tag, this); }
  createTextNode(text: string) { return new Text(text); }
  querySelector() { return null; }
  addEventListener() {}
}

function all(root: Element): Element[] {
  return [root, ...root.children.flatMap((c) => (c instanceof Element ? all(c) : []))];
}
const byTag = (root: Element, tag: string) => all(root).filter((n) => n.tagName === tag.toUpperCase());
const byText = (root: Element, tag: string, text: string) => byTag(root, tag).find((n) => n.textContent === text);

interface Reply { status?: number; json?: unknown; chunks?: string[] }

function page(replies: Record<string, Reply | (() => Reply)>, options: { assistant?: boolean } = {}) {
  const doc = new FakeDocument(options.assistant ?? true);
  const calls: { method: string; path: string; body?: any; authorization: string }[] = [];
  const listeners: Record<string, Function> = {};
  const window = {
    addEventListener: (event: string, fn: Function) => { listeners[event] = fn; },
    Clerk: { session: { getToken: async () => 'session-token' } },
    matchMedia: () => ({ matches: false }),
    location: { search: '', pathname: '/review', hash: '' },
    history: { replaceState() {} },
    scrollY: 0,
    scrollBy() {},
  };
  const ui = runInNewContext(`${REVIEW_JS}\n${ASSISTANT_JS}\n({
    assistantState, panel, formatAnswer, activityLabel, sendAssistant, refreshAssistantStatus, connectAssistant,
    hasWorkInProgress, setAssistantOpen, startAssistant: () => assistant.start(), ask: (...a) => assistant.ask(...a),
    pageChanged: () => assistant.pageChanged(),
    setPage: (book, queue, title, scene) => { view = book ? { book } : null; latestQueue = queue; currentBookTitle = title || ''; openScene = scene || null; },
  })`, {
    document: doc,
    window,
    setInterval: () => 1,
    clearInterval() {},
    setTimeout: () => 1,
    TextDecoder,
    URLSearchParams,
    fetch: async (url: string, options: any) => {
      const path = url.replace('/review/api/engine', '');
      calls.push({ method: options.method, path, body: options.body ? JSON.parse(options.body) : undefined, authorization: options.headers.authorization });
      const found = replies[`${options.method} ${path}`];
      const reply = typeof found === 'function' ? found() : found ?? { status: 404, json: {} };
      const status = reply.status ?? 200;
      const chunks = [...(reply.chunks ?? [])];
      return {
        ok: status < 400,
        status,
        json: async () => reply.json,
        body: { getReader: () => ({ read: async () => (chunks.length ? { done: false, value: Buffer.from(chunks.shift()!) } : { done: true }) }) },
      };
    },
  });
  ui.startAssistant();
  return { ...ui, doc, calls, root: () => ui.panel.root as Element };
}

const connected = { 'GET /status': { json: { state: 'connected' } } };
const sse = (...events: [string, object][]) => events.map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join('');

test('the panel exists only when the page says the engine is on, and starts closed', () => {
  const off = page({}, { assistant: false });
  assert.equal(off.panel.root, undefined);
  const ui = page({});
  assert.equal(ui.root().hidden, true);
  assert.equal(ui.root().tagName, 'ASIDE');
  assert.equal(ui.root().attrs['aria-label'], 'Asistente');
  assert.equal(ui.root().attrs.role, undefined, 'not a dialog: the review page pauses its refresh while a dialog is open');
  assert.equal(ui.panel.fab.attrs['aria-label'], 'Asistente');
  assert.equal(ui.panel.fab.attrs['aria-expanded'], 'false');
});

test('opening and closing the panel keeps the page and moves focus sensibly', async () => {
  const ui = page(connected);
  ui.setPage('sal', null, 'La puerta de Sal');
  ui.panel.fab.events.click();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(ui.root().hidden, false);
  assert.ok(ui.doc.body.classList.contains('assistant-open'));
  assert.equal(ui.panel.fab.attrs['aria-expanded'], 'true');
  assert.equal(ui.doc.toggle.attrs['aria-expanded'], 'true');
  assert.ok(ui.panel.context.textContent.includes('La puerta de Sal'), 'the selected book is shown without typing it');
  ui.panel.input.value = 'texto sin enviar';
  ui.root().events.keydown({ key: 'Escape' });
  assert.equal(ui.root().hidden, true);
  assert.equal(ui.doc.activeElement, ui.panel.fab, 'focus goes back to what opened it');
  assert.equal(ui.panel.input.value, 'texto sin enviar', 'closing keeps unsent text');
});

test('a disconnected writer connects inside the panel: code, the fixed OpenAI address, waiting', async () => {
  const ui = page({
    'GET /status': { json: { state: 'disconnected' } },
    'POST /login': { json: { user_code: 'FAKE-1234', verification_uri: 'https://auth.openai.com/codex/device', expires_in: 900 } },
  });
  await ui.refreshAssistantStatus();
  assert.equal(ui.panel.form.hidden, true, 'no prompt before connecting');
  await byText(ui.panel.log, 'button', 'Conectar ChatGPT')!.events.click();
  assert.equal(byTag(ui.panel.log, 'strong')[0].textContent, 'FAKE-1234');
  const link = byTag(ui.panel.log, 'a')[0];
  assert.equal(link.attrs.href, 'https://auth.openai.com/codex/device');
  assert.equal(link.attrs.target, '_blank');
  assert.equal(link.attrs.rel, 'noopener noreferrer');
  assert.ok(ui.panel.log.textContent.includes('Esperando a que confirmes en OpenAI…'));
  assert.equal(ui.panel.state.textContent, 'Esperando el código');
  assert.ok(ui.calls.every((call) => call.authorization === 'Bearer session-token'));
});

test('a refused login shows a fixed Spanish message, whatever the server body says', async () => {
  const ui = page({ 'POST /login': { status: 429, json: { error: 'busy', detail: 'raw detail' } } });
  await ui.connectAssistant();
  const alert = byTag(ui.panel.log, 'p').find((n) => n.attrs.role === 'alert');
  assert.equal(alert?.textContent, 'Hay demasiadas personas usando el asistente. Prueba de nuevo en unos minutos.');
  assert.ok(!ui.panel.log.textContent.includes('raw detail'));
  const odd = page({ 'POST /login': { status: 500, json: { error: 'something new <b>' } } });
  await odd.connectAssistant();
  assert.ok(odd.panel.log.textContent.includes('El asistente no está disponible ahora mismo.'));
});

test('a connected empty panel offers quick actions that only fill the prompt', async () => {
  const ui = page(connected);
  ui.setPage('sal', null, 'La puerta de Sal', { file: 'scenes/003-el-faro.md' });
  await ui.refreshAssistantStatus();
  const chips = byTag(ui.panel.log, 'button').map((b) => b.textContent);
  assert.deepEqual(chips, ['Analiza esta escena', 'Busca incoherencias en el libro', 'Resume los cambios pendientes', '¿Qué hallazgos debería revisar primero?']);
  await byText(ui.panel.log, 'button', 'Analiza esta escena')!.events.click();
  assert.equal(ui.panel.input.value, 'Analiza esta escena');
  assert.equal(ui.doc.activeElement, ui.panel.input);
  assert.ok(ui.panel.context.textContent.includes('Escena: escena 3'), 'the open scene becomes the item');
  assert.equal(ui.calls.filter((c) => c.path === '/prompt').length, 0, 'nothing is sent');
  ui.setPage('sal', null, 'La puerta de Sal', null);
  ui.assistantState.item = null;
  await ui.refreshAssistantStatus();
  assert.equal(byText(ui.panel.log, 'button', 'Analiza esta escena'), undefined, 'no scene open, no scene action');
});

test('an answer streams as formatted elements with activity labels, and the context goes as ids', async () => {
  const ui = page({
    ...connected,
    'POST /prompt': { chunks: [
      sse(['tool', { name: 'read_scene', phase: 'start', call: 1, scene: 'scenes/003-el-faro.md' }]),
      sse(['tool', { name: 'read_scene', phase: 'end', ok: true, call: 1, scene: 'scenes/003-el-faro.md' }]) + 'event: delta\ndata: {"text":"Hay **dos** puntos <img src=x onerror=alert(1)>:\\n\\n- uno\\n- dos\\n\\n> cita"}\n\nev',
      'ent: tool\ndata: {"name":"propose_findings","phase":"end","ok":true,"count":2}\n\n' + sse(['done', { aborted: false }]),
    ] },
  });
  ui.setPage('sal', { proposals: [], claims: [], finding_views: [] }, 'La puerta de Sal');
  await ui.refreshAssistantStatus();
  ui.ask({ kind: 'proposal', id: 'P-1', label: 'Cambio propuesto · 003-el-faro.md' }, 'borrador');
  await ui.sendAssistant('¿Hay incoherencias?');
  assert.deepEqual(ui.calls.at(-1)!.body, { text: '¿Hay incoherencias?', context: { book_id: 'sal', item: { kind: 'proposal', id: 'P-1' } } });
  const steps = byTag(ui.panel.log, 'li').filter((li) => li.parent?.className === 'activity').map((li) => [li.textContent, li.className]);
  assert.deepEqual(steps, [['Leída: escena 3', ''], ['Propuestos 2 hallazgos', '']]);
  const answer = byTag(ui.panel.log, 'div').find((n) => n.className === 'answer')!;
  assert.deepEqual(answer.children.map((c) => (c as Element).tagName), ['P', 'UL', 'BLOCKQUOTE']);
  assert.equal(byTag(answer, 'strong')[0].textContent, 'dos');
  assert.ok(answer.textContent.includes('<img src=x onerror=alert(1)>'), 'markup from the model stays text');
  assert.equal(byTag(answer, 'img').length, 0);
  assert.ok(byTag(ui.panel.log, 'div').some((n) => n.className === 'turn-user' && n.textContent === 'Sobre: Cambio propuesto · 003-el-faro.md¿Hay incoherencias?'));
  assert.equal(ui.assistantState.running, false);
  assert.equal(ui.panel.submit.textContent, 'Enviar');
});

test('what the assistant proposed gets a "Ver en la página" action once the page shows it', async () => {
  const ui = page({ ...connected, 'POST /prompt': { chunks: [sse(['tool', { name: 'propose_findings', phase: 'end', ok: true, count: 1 }], ['done', { aborted: false }])] } });
  const before = { proposals: [], claims: [], finding_views: [{ finding_id: 'N-old' }] };
  ui.setPage('sal', before, 'La puerta de Sal');
  await ui.refreshAssistantStatus();
  await ui.sendAssistant('Propón hallazgos');
  assert.ok(ui.panel.log.textContent.includes('Lo propuesto aparecerá en la página en unos segundos.'));

  // The page refreshes and now shows the new finding card.
  const section = ui.doc.createElement('section');
  section.id = 'sec-hallazgos';
  let opened = false;
  (section as any).fold = { setOpen: (open: boolean) => { opened = open; } };
  const card = ui.doc.createElement('article');
  card.setAttribute('data-item', 'narrative_finding:N-new');
  section.append(card);
  ui.doc.app.append(section);
  ui.setPage('sal', { proposals: [], claims: [], finding_views: [{ finding_id: 'N-old' }, { finding_id: 'N-new' }] }, 'La puerta de Sal');
  ui.setAssistantOpen(true, true);
  ui.pageChanged();
  assert.ok(ui.panel.log.textContent.includes('1 hallazgo nuevo'));
  byText(ui.panel.log, 'button', 'Ver en la página')!.events.click();
  assert.equal(opened, true, 'a folded section opens');
  assert.equal(card.scrolled, 1);
  assert.equal(ui.doc.activeElement, card);
  assert.ok(card.classList.contains('flash'));
});

test('turn errors become fixed messages; an expired connection brings the connect view back', async () => {
  const ui = page({ ...connected, 'POST /prompt': { chunks: [sse(['error', { code: 'reconnect' }])] } });
  await ui.refreshAssistantStatus();
  await ui.sendAssistant('hola');
  assert.ok(byText(ui.panel.log, 'h3', 'Vuelve a conectar ChatGPT'));

  const busy = page({ ...connected, 'POST /prompt': { status: 429, json: { error: 'busy' } } });
  await busy.refreshAssistantStatus();
  await busy.sendAssistant('hola');
  assert.equal(byTag(busy.panel.log, 'p').find((n) => n.attrs.role === 'alert')?.textContent, 'Hay demasiadas personas usando el asistente. Prueba de nuevo en unos minutos.');
  assert.equal(busy.panel.state.textContent, 'Error');
  await busy.sendAssistant('   ');
  assert.equal(busy.calls.filter((c) => c.path === '/prompt').length, 1, 'an empty message is not sent');

  const limit = page({ ...connected, 'POST /prompt': { chunks: [sse(['delta', { text: 'a medias' }], ['done', { aborted: true }])] } });
  await limit.refreshAssistantStatus();
  await limit.sendAssistant('largo');
  assert.ok(limit.panel.log.textContent.includes('Respuesta detenida.'));
  assert.equal(limit.panel.state.textContent, 'Detenida');
});

test('asking about a card sets the item and fills only an empty prompt', async () => {
  const ui = page(connected);
  ui.setPage('sal', null, 'La puerta de Sal');
  await ui.refreshAssistantStatus();
  ui.ask({ kind: 'claim', id: 'C-1', label: 'Afirmación: Elena no duerme' }, '¿Está bien apoyada?');
  assert.equal(ui.root().hidden, false);
  assert.equal(ui.panel.input.value, '¿Está bien apoyada?');
  assert.ok(ui.panel.context.textContent.includes('Afirmación: Elena no duerme'));
  ui.panel.input.value = 'mi pregunta';
  ui.ask({ kind: 'proposal', id: 'P-2', label: 'Cambio propuesto · x.md' }, 'otro borrador');
  assert.equal(ui.panel.input.value, 'mi pregunta', 'text the writer typed is kept');
  assert.ok(ui.panel.context.textContent.includes('Cambio propuesto · x.md'));
  byTag(ui.panel.context, 'button').find((b) => b.attrs['aria-label'] === 'Quitar la referencia')!.events.click();
  assert.equal(ui.assistantState.item, null);
});

test('a focused panel field does not hold back the page refresh, a page field still does', () => {
  const ui = page({});
  ui.panel.input.focus();
  assert.equal(ui.hasWorkInProgress(), false);
  const note = ui.doc.createElement('textarea');
  ui.doc.app.append(note);
  note.focus();
  assert.equal(ui.hasWorkInProgress(), true);
});

test('activity labels say what happens in Spanish and never show raw text', () => {
  const ui = page({});
  const label = (step: object) => ui.activityLabel(step);
  assert.equal(label({ name: 'read_scene', phase: 'start', scene: 'scenes/003-el-faro.md' }), 'Leyendo escena 3…');
  assert.equal(label({ name: 'read_scene', phase: 'start' }), 'Leyendo una escena…');
  assert.equal(label({ name: 'list_scenes', phase: 'end', ok: true, count: 1 }), '1 escena');
  assert.equal(label({ name: 'propose_revision', phase: 'end', ok: true, count: 0 }), 'Ese cambio ya estaba propuesto');
  assert.equal(label({ name: 'propose_findings', phase: 'end', ok: false }), 'Error: no se pudieron proponer los hallazgos');
  assert.equal(label({ name: 'read_scene', phase: 'end', ok: true, scene: 'scenes/escena-01.md' }), 'Leída: escena 01');
  assert.equal(label({ name: 'brand_new_tool', phase: 'start' }), 'Usando brand_new_tool…');
});

test('the panel follows docs/design.md: tokens, three breakpoints, 16 px fields, 44 px targets, no markup from text', () => {
  assert.doesNotMatch(ASSISTANT_CSS, /#[0-9a-fA-F]{3,8}\b/, 'no colour literal: the review page tokens only');
  assert.deepEqual([...ASSISTANT_CSS.matchAll(/\b(\d+)px\b/g)].map((m) => m[1]).filter((n) => !['1', '2', '3'].includes(n)), [], 'no spacing literal outside the scales');
  assert.deepEqual([...new Set([...ASSISTANT_CSS.matchAll(/@media \((?:max|min)-width: ([^)]+)\)/g)].map((m) => m[1]))], ['74.99em', '40em', '75em'], 'only the breakpoints the design rules name');
  assert.match(ASSISTANT_CSS, /\.assistant-fab \{[^}]*min-height: var\(--tap\)/);
  assert.match(ASSISTANT_CSS, /env\(safe-area-inset-bottom\)/);
  assert.doesNotMatch(ASSISTANT_CSS, /\.assistant textarea \{[^}]*font-size/, 'the field keeps the 16 px of the page controls');
  assert.doesNotMatch(ASSISTANT_JS, /innerHTML|outerHTML|insertAdjacentHTML|document\.write|DOMParser/);
});
