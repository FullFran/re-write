/**
 * The page where a writer talks with the embedded engine. Like the review page it holds
 * no data and renders everything with textContent: what the model writes, and what it
 * read from a manuscript, is untrusted. It works in one column from 360 px wide.
 */

function escapeAttribute(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

export function engineHtml(issuer: string, publishableKey: string): string {
  const frontendApi = escapeAttribute(issuer.replace(/\/$/, ''));
  return `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
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

export const ENGINE_CSS = `
:root { color-scheme: light dark; --ink: #1c1b19; --paper: #faf8f4; --line: #d9d4ca; --muted: #6b665c; --accent: #1f6b45; --warn: #a32a2a; --bubble: #efeae0; }
@media (prefers-color-scheme: dark) { :root { --ink: #ece8df; --paper: #1a1917; --line: #3a372f; --muted: #a39d90; --accent: #5fc08f; --warn: #ef8585; --bubble: #26241f; } }
* { box-sizing: border-box; }
html, body { height: 100%; }
body { margin: 0; display: flex; flex-direction: column; background: var(--paper); color: var(--ink); font: 16px/1.5 Georgia, 'Times New Roman', serif; }
header { display: flex; justify-content: space-between; align-items: center; gap: 12px; padding: 8px 16px; border-bottom: 1px solid var(--line); }
h1 { margin: 0; font-size: 18px; }
h2 { margin: 0 0 8px; font-size: 18px; }
nav { display: flex; align-items: center; gap: 12px; }
a { color: var(--accent); }
nav a { display: inline-flex; align-items: center; min-height: 44px; }
main { flex: 1; min-height: 0; width: 100%; max-width: 760px; margin: 0 auto; padding: 16px; display: flex; flex-direction: column; gap: 12px; }
p { margin: 0 0 8px; }
.muted { color: var(--muted); font-size: 14px; }
.panel { border: 1px solid var(--line); border-radius: 8px; padding: 16px; }
.code { display: block; margin: 12px 0; padding: 12px; border: 1px dashed var(--line); border-radius: 8px; text-align: center; font: 700 28px/1.2 ui-monospace, Menlo, Consolas, monospace; letter-spacing: 2px; overflow-wrap: anywhere; user-select: all; }
.row { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
button, .button { min-height: 44px; padding: 10px 16px; border: 1px solid var(--line); border-radius: 8px; background: transparent; color: var(--ink); font: inherit; font-size: 16px; cursor: pointer; text-decoration: none; display: inline-flex; align-items: center; justify-content: center; }
button.primary, .button.primary { background: var(--accent); border-color: var(--accent); color: var(--paper); }
button.danger { color: var(--warn); }
button:disabled { opacity: 0.5; cursor: default; }
.messages { flex: 1; min-height: 120px; overflow-y: auto; display: flex; flex-direction: column; gap: 8px; padding: 4px 0; }
.message { max-width: 92%; padding: 10px 12px; border-radius: 12px; white-space: pre-wrap; overflow-wrap: anywhere; }
.message.user { align-self: flex-end; background: var(--accent); color: var(--paper); }
.message.assistant { align-self: flex-start; background: var(--bubble); }
.message.note { align-self: center; color: var(--muted); font-size: 14px; padding: 2px 8px; }
.message.error { align-self: center; color: var(--warn); font-size: 14px; }
form { display: flex; gap: 8px; align-items: flex-end; }
textarea { flex: 1; min-width: 0; min-height: 44px; max-height: 40vh; padding: 10px 12px; border: 1px solid var(--line); border-radius: 8px; background: transparent; color: var(--ink); font: inherit; font-size: 16px; resize: vertical; }
@media (max-width: 480px) { header { padding: 8px 12px; } main { padding: 12px; } .message { max-width: 100%; } }
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
  if (status.state === 'pending') {
    panel.append(
      el('h2', '', 'Escribe este código en OpenAI'),
      el('p', '', 'Abre la página de OpenAI, inicia sesión con tu cuenta de ChatGPT y escribe el código. Esta página se actualizará sola.'),
      el('strong', 'code', status.user_code || '…'),
    );
    const row = el('div', 'row');
    const link = el('a', 'button primary', 'Abrir OpenAI');
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
  row.append(button('Conectar ChatGPT', 'primary', connect));
  if (status.state === 'reconnect') row.append(button('Desconectar', 'danger', disconnect));
  panel.append(row);
  return panel;
}

function chat() {
  const list = el('div', 'messages');
  if (state.messages.length === 0) list.append(el('p', 'muted', 'Pregunta por tu libro: personajes, continuidad, una escena que no encaja.'));
  for (const message of state.messages) list.append(el('div', 'message ' + message.role, message.text || '…'));
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
  form.append(input, state.running ? button('Detener', 'danger', stop) : button('Enviar', 'primary', submit));
  const footer = el('div', 'row');
  footer.append(button('Desconectar ChatGPT', '', disconnect), el('span', 'muted', 'La conversación no se guarda: se pierde al cerrar o tras un rato sin usarla.'));
  return [list, form, footer];
}

function render() {
  const nodes = state.status.state === 'connected' ? chat() : [connectPanel()];
  if (state.notice) nodes.unshift(el('p', 'message error', state.notice));
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
    app.replaceChildren(el('p', 'message error', 'No se pudo cargar la página'));
  }
});
`;
