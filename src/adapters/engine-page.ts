/**
 * The page where a writer talks with the embedded engine. Like the review page it holds
 * no data and renders everything with textContent: what the model writes, and what it
 * read from a manuscript, is untrusted. It follows docs/design.md: the review page's
 * tokens, one centred column at every size, controls of at least 44 px.
 */
import { REVIEW_CSS } from './review-page.ts';

function escapeAttribute(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

export function engineHtml(issuer: string, publishableKey: string): string {
  const frontendApi = escapeAttribute(issuer.replace(/\/$/, ''));
  return `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>RE;write · Asistente</title>
<link rel="stylesheet" href="/review/engine/app.css">
<script defer crossorigin="anonymous" src="${frontendApi}/npm/@clerk/ui@1/dist/ui.browser.js"></script>
<script defer crossorigin="anonymous" data-clerk-publishable-key="${escapeAttribute(publishableKey)}" src="${frontendApi}/npm/@clerk/clerk-js@6/dist/clerk.browser.js"></script>
<script defer src="/review/engine/app.js"></script>
</head>
<body>
<header><h1>RE;write · Asistente</h1><nav><a href="/review">Revisión</a><div id="user"></div></nav></header>
<main id="app"><p>Cargando…</p></main>
</body>
</html>
`;
}

/**
 * The colour roles and the spacing, type and control scales of docs/design.md, taken from
 * the review page so both pages share one definition instead of two copies.
 */
const TOKENS_START = ':root {';
const TOKENS_END = '* { box-sizing';
if (!REVIEW_CSS.includes(TOKENS_START) || !REVIEW_CSS.includes(TOKENS_END)) throw new Error('design tokens not found in the review page styles');
const DESIGN_TOKENS = REVIEW_CSS.slice(REVIEW_CSS.indexOf(TOKENS_START), REVIEW_CSS.indexOf(TOKENS_END));

export const ENGINE_CSS = `
/* Roles, scales and breakpoints are described in docs/design.md. */
${DESIGN_TOKENS}
* { box-sizing: border-box; }
html { height: 100%; -webkit-text-size-adjust: 100%; text-size-adjust: 100%; }
body { margin: 0; min-height: 100%; display: flex; flex-direction: column; background: var(--paper); color: var(--ink); font: var(--text-md)/1.6 var(--font-prose); overflow-wrap: anywhere; }
header { display: flex; justify-content: space-between; align-items: center; gap: var(--space-3); padding: var(--space-2) max(var(--gutter), calc((100% - var(--measure)) / 2 + var(--gutter))); padding-top: max(var(--space-2), env(safe-area-inset-top)); border-bottom: 1px solid var(--line); }
h1 { margin: 0; font: 700 var(--text-lg)/1.3 var(--font-ui); }
h2 { margin: 0 0 var(--space-2); font: 700 var(--text-lg)/1.3 var(--font-ui); }
nav { display: flex; align-items: center; gap: var(--space-3); font: var(--text-md)/1.3 var(--font-ui); }
a { color: inherit; }
nav a { display: inline-flex; align-items: center; min-height: var(--tap); }
#user { display: flex; align-items: center; justify-content: flex-end; min-width: var(--tap); min-height: var(--tap); }
main { flex: 1; min-height: 0; width: 100%; max-width: var(--measure); margin: 0 auto; padding: var(--space-4) var(--gutter) calc(var(--space-4) + env(safe-area-inset-bottom)); display: flex; flex-direction: column; gap: var(--space-3); }
p { margin: 0 0 var(--space-2); }
:focus-visible { outline: 2px solid var(--ink); outline-offset: 2px; }
.muted { color: var(--muted); font: var(--text-sm)/1.45 var(--font-ui); }
.panel { border: 1px solid var(--line); border-radius: var(--radius); padding: var(--space-4); }
.code { display: block; margin: var(--space-3) 0; padding: var(--space-3); border: 1px solid var(--edge); border-radius: var(--radius); text-align: center; font: 700 var(--text-xl)/1.3 var(--font-code); letter-spacing: .1em; user-select: all; }
.row { display: flex; flex-wrap: wrap; gap: var(--space-3); align-items: center; }
button, .button, textarea { min-height: var(--tap); max-width: 100%; margin: 0; padding: var(--space-2) var(--space-4); border: 1px solid var(--edge); border-radius: var(--radius); background: transparent; color: inherit; font: var(--text-md)/1.3 var(--font-ui); touch-action: manipulation; }
button, .button { display: inline-flex; align-items: center; justify-content: center; cursor: pointer; text-decoration: none; transition: background-color .12s, opacity .12s; }
button.accept, .button.accept { border-color: var(--accept); background: var(--accept); color: var(--paper); font-weight: 600; }
button.reject { border-color: var(--reject); color: var(--reject); font-weight: 600; }
button:disabled { opacity: .5; cursor: default; }
@media (hover: hover) {
  button:not(:disabled):hover, .button:hover { background: var(--pressed); }
  button.accept:not(:disabled):hover, .button.accept:hover { background: var(--accept); opacity: .85; }
}
.messages { flex: 1; min-height: 8rem; overflow-y: auto; display: flex; flex-direction: column; gap: var(--space-2); padding: var(--space-1) 0; }
/* Who speaks is said by position, outline and a label for screen readers, not by colour alone. */
.message { max-width: 92%; padding: var(--space-2) var(--space-3); border-radius: var(--radius); white-space: pre-wrap; }
.message.user { align-self: flex-end; background: var(--pressed); font: var(--text-md)/1.45 var(--font-ui); }
.message.assistant { align-self: flex-start; border: 1px solid var(--line); }
.message.note { align-self: center; padding: 0 var(--space-2); color: var(--muted); font: var(--text-sm)/1.45 var(--font-ui); }
[role=alert] { align-self: stretch; max-width: none; margin: 0; padding: var(--space-3) var(--space-4); border: 1px solid var(--reject); border-left-width: var(--space-1); border-radius: var(--radius); background: var(--reject-bg); font: var(--text-sm)/1.45 var(--font-ui); }
form { display: flex; gap: var(--space-3); align-items: flex-end; }
textarea { flex: 1 1 auto; min-width: 0; max-height: 40vh; padding: var(--space-2) var(--space-3); resize: vertical; }
@media (max-width: 40em) {
  .message { max-width: 100%; }
  .row > button, .row > .button { flex: 1 1 100%; }
}
@media (min-width: 48em) {
  main { padding-top: var(--space-5); }
}
@media (prefers-reduced-motion: reduce) {
  button, .button { transition: none; }
}
`;

export const ENGINE_JS = String.raw`
const app = document.getElementById('app');
const MESSAGES = {
  model_busy: 'El modelo está ocupado ahora mismo. Prueba de nuevo en un momento.',
  reconnect: 'Tu conexión con ChatGPT ha caducado. Vuelve a conectarla.',
  provider_error: 'El proveedor del modelo ha devuelto un error. Prueba de nuevo.',
  busy: 'Hay demasiadas personas usando el asistente. Prueba de nuevo en unos minutos.',
  turn_in_progress: 'Ya hay una respuesta en curso. Espera a que termine o detenla.',
  not_connected: 'Conecta tu cuenta de ChatGPT para empezar.',
  engine_unavailable: 'El asistente no está disponible ahora mismo.',
  login_failed: 'No se pudo iniciar la conexión con ChatGPT. Prueba de nuevo.',
  rate_limited: 'Has pedido demasiados códigos seguidos. Espera unos minutos y prueba de nuevo.',
  turn_limit: 'La respuesta se ha detenido porque era demasiado larga o tardaba demasiado.',
};
const state = { status: { state: 'disconnected' }, messages: [], running: false, notice: '', poll: null };

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function button(label, className, onClick) {
  const node = el('button', className, label);
  node.setAttribute('type', 'button');
  node.addEventListener('click', onClick);
  return node;
}

async function api(method, path, body) {
  const token = await window.Clerk.session.getToken();
  return fetch('/review/api/engine' + path, {
    method,
    headers: Object.assign({ authorization: 'Bearer ' + token }, body === undefined ? {} : { 'content-type': 'application/json' }),
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

function messageFor(code) {
  return MESSAGES[code] || MESSAGES.engine_unavailable;
}

async function failure(res) {
  let code = 'engine_unavailable';
  try { code = (await res.json()).error; } catch (error) { /* keep the fixed code */ }
  return messageFor(code);
}

async function refreshStatus() {
  const res = await api('GET', '/status');
  if (res.ok) state.status = await res.json();
  // The engine does not exist for someone who cannot use a book yet.
  else if (res.status === 404) state.status = { state: 'unavailable' };
  if (state.status.state !== 'pending' && state.poll) {
    clearInterval(state.poll);
    state.poll = null;
  }
  render();
}

async function connect() {
  state.notice = '';
  const res = await api('POST', '/login');
  if (!res.ok) {
    state.notice = await failure(res);
    return render();
  }
  const login = await res.json();
  state.status = { state: 'pending', user_code: login.user_code, verification_uri: login.verification_uri };
  if (!state.poll) state.poll = setInterval(refreshStatus, 3000);
  render();
}

async function disconnect() {
  await api('DELETE', '/credential');
  state.messages = [];
  state.notice = '';
  await refreshStatus();
}

function parseEvents(buffer, onEvent) {
  let index;
  while ((index = buffer.indexOf('\n\n')) >= 0) {
    const block = buffer.slice(0, index);
    buffer = buffer.slice(index + 2);
    const event = /^event: (.*)$/m.exec(block);
    const data = /^data: (.*)$/m.exec(block);
    if (event && data) onEvent(event[1], JSON.parse(data[1]));
  }
  return buffer;
}

async function sendPrompt(text) {
  if (state.running || !text.trim()) return;
  state.running = true;
  state.notice = '';
  state.messages.push({ role: 'user', text });
  const answer = { role: 'assistant', text: '' };
  state.messages.push(answer);
  render();
  try {
    const res = await api('POST', '/prompt', { text });
    if (!res.ok) {
      state.messages.pop();
      state.messages.push({ role: 'error', text: await failure(res) });
      if (res.status === 409) await refreshStatus();
      return;
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) {
      buffer = parseEvents(buffer + decoder.decode(chunk.value, { stream: true }), (event, data) => {
        if (event === 'delta') answer.text += data.text;
        if (event === 'tool') state.messages.splice(state.messages.indexOf(answer), 0, { role: 'note', text: (data.ok ? 'Consultado: ' : 'Falló: ') + data.name });
        if (event === 'done' && data.aborted) state.messages.push({ role: 'note', text: 'Respuesta detenida.' });
        if (event === 'error') {
          state.messages.push({ role: 'error', text: messageFor(data.code) });
          if (data.code === 'reconnect') state.status = { state: 'reconnect' };
        }
        render();
      });
    }
  } catch (error) {
    state.messages.push({ role: 'error', text: MESSAGES.engine_unavailable });
  } finally {
    if (!answer.text) state.messages = state.messages.filter((message) => message !== answer);
    state.running = false;
    render();
  }
}

async function stop() {
  await api('POST', '/abort');
}

function connectPanel() {
  const panel = el('section', 'panel');
  const status = state.status;
  if (status.state === 'unavailable') {
    const link = el('a', 'button accept', 'Ir a Revisión');
    link.setAttribute('href', '/review');
    panel.append(el('h2', '', 'Primero necesitas un libro'), el('p', '', 'El asistente trabaja sobre tus libros. Crea uno o pide acceso a uno en Revisión y vuelve aquí.'), link);
    return panel;
  }
  if (status.state === 'pending') {
    panel.append(
      el('h2', '', 'Escribe este código en OpenAI'),
      el('p', '', 'Abre la página de OpenAI, inicia sesión con tu cuenta de ChatGPT y escribe el código. Esta página se actualizará sola.'),
      el('strong', 'code', status.user_code || '…'),
    );
    const row = el('div', 'row');
    const link = el('a', 'button accept', 'Abrir OpenAI');
    link.setAttribute('href', status.verification_uri);
    link.setAttribute('target', '_blank');
    link.setAttribute('rel', 'noopener noreferrer');
    row.append(link, button('Pedir otro código', '', connect));
    panel.append(row, el('p', 'muted', 'El código caduca en 15 minutos. Nunca lo escribas en otra dirección que no sea auth.openai.com.'));
    return panel;
  }
  panel.append(
    el('h2', '', status.state === 'reconnect' ? 'Vuelve a conectar ChatGPT' : 'Conecta tu cuenta de ChatGPT'),
    el('p', '', 'El asistente usa tu propia suscripción de ChatGPT. Puede leer tus libros y proponer cambios; aceptar o rechazar sigue siendo cosa tuya, en Revisión.'),
    el('p', 'muted', 'El texto que el asistente lea de tus libros se envía a OpenAI con tu cuenta.'),
  );
  const row = el('div', 'row');
  row.append(button('Conectar ChatGPT', 'accept', connect));
  if (status.state === 'reconnect') row.append(button('Desconectar', 'reject', disconnect));
  panel.append(row);
  return panel;
}

function chat() {
  const list = el('div', 'messages');
  if (state.messages.length === 0) list.append(el('p', 'muted', 'Pregunta por tu libro: personajes, continuidad, una escena que no encaja.'));
  list.setAttribute('role', 'log');
  list.setAttribute('aria-label', 'Conversación');
  for (const message of state.messages) {
    const bubble = el('div', 'message ' + message.role, message.text || '…');
    if (message.role === 'error') bubble.setAttribute('role', 'alert');
    if (message.role === 'user') bubble.setAttribute('aria-label', 'Tú');
    if (message.role === 'assistant') bubble.setAttribute('aria-label', 'Asistente');
    list.append(bubble);
  }
  const form = el('form');
  const input = el('textarea');
  input.id = 'prompt';
  input.setAttribute('rows', '2');
  input.setAttribute('maxlength', '8000');
  input.setAttribute('placeholder', 'Escribe tu mensaje');
  input.setAttribute('aria-label', 'Mensaje');
  input.disabled = state.running;
  const submit = () => {
    const text = input.value;
    input.value = '';
    return sendPrompt(text);
  };
  form.addEventListener('submit', (event) => { event.preventDefault(); return submit(); });
  form.append(input, state.running ? button('Detener', 'reject', stop) : button('Enviar', 'accept', submit));
  const footer = el('div', 'row');
  footer.append(button('Desconectar ChatGPT', '', disconnect), el('span', 'muted', 'La conversación no se guarda: se pierde al cerrar o tras un rato sin usarla.'));
  return [list, form, footer];
}

function render() {
  const nodes = state.status.state === 'connected' ? chat() : [connectPanel()];
  if (state.notice) {
    const alert = el('p', '', state.notice);
    alert.setAttribute('role', 'alert');
    nodes.unshift(alert);
  }
  app.replaceChildren(...nodes);
  const list = nodes.find((node) => node.className === 'messages');
  if (list) list.scrollTop = list.scrollHeight;
}

window.addEventListener('load', async () => {
  try {
    await window.Clerk.load({ ui: { ClerkUI: window.__internal_ClerkUICtor } });
    if (!window.Clerk.isSignedIn) {
      const box = el('div');
      app.replaceChildren(box);
      window.Clerk.mountSignIn(box);
      return;
    }
    window.Clerk.mountUserButton(document.getElementById('user'));
    await refreshStatus();
  } catch (error) {
    const alert = el('p', '', 'No se pudo cargar la página');
    alert.setAttribute('role', 'alert');
    app.replaceChildren(alert);
  }
});
`;
