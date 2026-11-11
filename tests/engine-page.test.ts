import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import { ENGINE_CSS, ENGINE_JS, engineHtml } from '../src/adapters/engine-page.ts';

// Minimal DOM adapter: execute the shipped script, not a second rendering implementation.
class Element {
  tag: string;
  children: Element[] = [];
  ownText = '';
  className = '';
  value = '';
  disabled = false;
  id = '';
  scrollTop = 0;
  scrollHeight = 0;
  attrs: Record<string, string> = {};
  events: Record<string, Function> = {};
  constructor(tag: string) { this.tag = tag; }
  set textContent(text: string) { this.ownText = text; this.children = []; }
  get textContent(): string { return this.ownText + this.children.map((c) => c.textContent).join(''); }
  append(...nodes: Element[]) { this.children.push(...nodes); }
  replaceChildren(...nodes: Element[]) { this.ownText = ''; this.children = [...nodes]; }
  setAttribute(key: string, value: string) { this.attrs[key] = value; }
  addEventListener(event: string, fn: Function) { this.events[event] = fn; }
}
function nodes(root: Element, tag: string): Element[] {
  return [...(root.tag === tag ? [root] : []), ...root.children.flatMap((c) => nodes(c, tag))];
}
const byText = (root: Element, tag: string, text: string) => nodes(root, tag).find((n) => n.textContent === text);

interface Reply { status?: number; json?: unknown; chunks?: string[] }

function page(replies: Record<string, Reply | (() => Reply)>) {
  const app = new Element('main');
  const calls: { method: string; path: string; body?: any; authorization: string }[] = [];
  const context = runInNewContext(`${ENGINE_JS}\n({ state, render, refreshStatus, connect, disconnect, sendPrompt })`, {
    document: { getElementById: (id: string) => id === 'app' ? app : new Element('div'), createElement: (tag: string) => new Element(tag) },
    window: { addEventListener() {}, Clerk: { session: { getToken: async () => 'session-token' } } },
    setInterval: () => 1,
    clearInterval() {},
    TextDecoder,
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
        body: { getReader: () => ({ read: async () => chunks.length ? { done: false, value: Buffer.from(chunks.shift()!) } : { done: true } }) },
      };
    },
  });
  return { ...context, app, calls };
}

test('a disconnected writer gets one button, and connecting shows the code and the OpenAI address', async () => {
  const ui = page({
    'GET /status': { json: { state: 'disconnected' } },
    'POST /login': { json: { user_code: 'FAKE-1234', verification_uri: 'https://auth.openai.com/codex/device', expires_in: 900 } },
  });
  await ui.refreshStatus();
  const connect = byText(ui.app, 'button', 'Conectar ChatGPT');
  assert.ok(connect);
  assert.equal(nodes(ui.app, 'textarea').length, 0, 'no chat before connecting');

  await connect.events.click();
  assert.equal(nodes(ui.app, 'strong')[0].textContent, 'FAKE-1234');
  const link = nodes(ui.app, 'a')[0];
  assert.equal(link.attrs.href, 'https://auth.openai.com/codex/device');
  assert.equal(link.attrs.target, '_blank');
  assert.equal(link.attrs.rel, 'noopener noreferrer');
  assert.ok(ui.calls.every((call) => call.authorization === 'Bearer session-token'));
});

test('a refused login shows a fixed Spanish message, whatever the server body says', async () => {
  const ui = page({ 'POST /login': { status: 429, json: { error: 'busy', detail: 'raw detail' } } });
  await ui.connect();
  assert.ok(ui.app.textContent.includes('Hay demasiadas personas usando el asistente'));
  assert.ok(!ui.app.textContent.includes('raw detail'));
  const odd = page({ 'POST /login': { status: 500, json: { error: 'something new <b>' } } });
  await odd.connect();
  assert.ok(odd.app.textContent.includes('El asistente no está disponible ahora mismo.'));
  assert.ok(!odd.app.textContent.includes('something new'));
});

test('an answer streams into one bubble as text, even when events are split across chunks', async () => {
  const ui = page({
    'GET /status': { json: { state: 'connected' } },
    'POST /prompt': { chunks: [
      'event: delta\ndata: {"text":"Hola <img src=x onerror=alert(1)> "}\n\neve',
      'nt: tool\ndata: {"name":"list_books","ok":true}\n\nevent: delta\ndata: {"text":"mundo"}\n\n',
      'event: done\ndata: {"aborted":false}\n\n',
    ] },
  });
  await ui.refreshStatus();
  assert.ok(byText(ui.app, 'button', 'Enviar'));
  await ui.sendPrompt('¿Qué libros tengo?');
  assert.deepEqual(ui.calls.at(-1), { method: 'POST', path: '/prompt', body: { text: '¿Qué libros tengo?' }, authorization: 'Bearer session-token' });
  const bubbles = nodes(ui.app, 'div').filter((n) => n.className.startsWith('message '));
  assert.deepEqual(bubbles.map((n) => [n.className, n.textContent]), [
    ['message user', '¿Qué libros tengo?'],
    ['message note', 'Consultado: list_books'],
    ['message assistant', 'Hola <img src=x onerror=alert(1)> mundo'],
  ]);
  assert.equal(nodes(ui.app, 'img').length, 0, 'model output never becomes markup');
  assert.equal(ui.state.running, false);
});

test('errors in a turn become fixed messages, and an expired connection brings the connect panel back', async () => {
  const ui = page({
    'GET /status': { json: { state: 'connected' } },
    'POST /prompt': { chunks: ['event: error\ndata: {"code":"reconnect"}\n\n'] },
  });
  await ui.refreshStatus();
  await ui.sendPrompt('hola');
  assert.ok(byText(ui.app, 'h2', 'Vuelve a conectar ChatGPT'));

  const refused = page({ 'GET /status': { json: { state: 'connected' } }, 'POST /prompt': { status: 409, json: { error: 'turn_in_progress' } } });
  await refused.refreshStatus();
  await refused.sendPrompt('hola');
  assert.ok(refused.app.textContent.includes('Ya hay una respuesta en curso'));
  await refused.sendPrompt('   ');
  assert.equal(refused.calls.filter((call) => call.path === '/prompt').length, 1, 'an empty message is not sent');
});

test('disconnect calls the server and clears the conversation', async () => {
  let connected = true;
  const ui = page({
    'GET /status': () => ({ json: { state: connected ? 'connected' : 'disconnected' } }),
    'DELETE /credential': () => { connected = false; return { json: { state: 'disconnected' } }; },
    'POST /prompt': { chunks: ['event: delta\ndata: {"text":"hola"}\n\nevent: done\ndata: {"aborted":false}\n\n'] },
  });
  await ui.refreshStatus();
  await ui.sendPrompt('hola');
  await byText(ui.app, 'button', 'Desconectar ChatGPT')!.events.click();
  assert.ok(ui.calls.some((call) => call.method === 'DELETE' && call.path === '/credential'));
  assert.equal(ui.state.messages.length, 0);
  assert.ok(byText(ui.app, 'button', 'Conectar ChatGPT'));
});

test('the page is built for a phone: one column, 16 px inputs, 44 px targets', () => {
  const html = engineHtml('https://clerk.example.com/', 'pk_test_"placeholder');
  assert.match(html, /<meta name="viewport" content="width=device-width, initial-scale=1">/);
  assert.match(html, /<a href="\/review">/);
  assert.match(html, /data-clerk-publishable-key="pk_test_&quot;placeholder"/);
  assert.match(ENGINE_CSS, /textarea \{[^}]*font-size: 16px/);
  assert.match(ENGINE_CSS, /button, \.button \{ min-height: 44px;[^}]*font-size: 16px/);
  assert.match(ENGINE_CSS, /main \{[^}]*max-width: 760px[^}]*flex-direction: column/);
  assert.doesNotMatch(ENGINE_CSS, /min-width: (3[6-9]\d|[4-9]\d\d)px/, 'nothing forces a width over 360 px');
  assert.doesNotMatch(ENGINE_JS, /innerHTML|outerHTML|insertAdjacentHTML|document\.write/);
});
