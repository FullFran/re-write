/**
 * The assistant panel of the review page: where a writer talks with the embedded engine
 * without leaving what they are reading. The server appends these styles and this script
 * to the review page's own when the engine is enabled, so the panel shares its tokens,
 * its helpers (`el`, `view`, `scrollBehavior`, `viewportAnchor`) and its refresh.
 *
 * Like the review page it renders everything as DOM nodes with textContent: what the
 * model writes, and what it read from a manuscript, is untrusted. Formatting (paragraphs,
 * lists, quotes, emphasis, inline code) is parsed here into elements, never into markup.
 * Its rules are in docs/design.md ("Assistant panel").
 */

export const ASSISTANT_CSS = `
/* Assistant panel: docs/design.md, "Assistant panel". */
.header-toggle { min-height: var(--tap); padding: 0 var(--space-3); }
.assistant-fab { position: fixed; z-index: 4; right: var(--gutter); bottom: max(var(--space-5), env(safe-area-inset-bottom)); display: inline-flex; align-items: center; gap: var(--space-2); min-width: var(--tap); min-height: var(--tap); padding: var(--space-2) var(--space-4); border: 1px solid var(--accept); border-radius: var(--tap); background: var(--accept); color: var(--paper); font: 600 var(--text-md)/1.3 var(--font-ui); box-shadow: 0 var(--space-1) var(--space-3) rgb(0 0 0 / .25); }
/* A speech bubble drawn with borders: no image, no markup. */
.assistant-fab::before { content: ''; flex: none; width: var(--space-4); height: var(--space-3); border: 2px solid currentColor; border-radius: var(--space-1) var(--space-1) var(--space-1) 0; }
.assistant-fab.compact { justify-content: center; padding: 0; }
.assistant-fab.compact > span { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
.assistant-fab.compact:focus-visible { padding: var(--space-2) var(--space-4); }
.assistant-fab.compact:focus-visible > span { position: static; width: auto; height: auto; clip-path: none; }
.assistant-open .assistant-fab { display: none; }
.assistant-scrim { position: fixed; inset: 0; z-index: 4; background: rgb(0 0 0 / .35); }
.assistant-scrim[hidden], .assistant[hidden] { display: none; }
.assistant { position: fixed; z-index: 5; display: flex; flex-direction: column; background: var(--paper); color: var(--ink); font: var(--text-md)/1.5 var(--font-ui); }
.assistant-head { position: relative; display: flex; align-items: center; gap: var(--space-2); padding: var(--space-2) var(--space-2) var(--space-2) var(--space-4); border-bottom: 1px solid var(--line); }
.assistant-head h2 { flex: 1; margin: 0; font: 700 var(--text-lg)/1.3 var(--font-ui); }
.assistant-head h2:focus { outline: none; }
.assistant-state { display: inline-flex; align-items: center; gap: var(--space-1); color: var(--muted); font: var(--text-sm)/1.3 var(--font-ui); }
/* The state has its word; the dot only repeats it. */
.assistant-state::before { content: ''; width: var(--space-2); height: var(--space-2); border: 1px solid var(--edge); border-radius: 50%; }
.assistant-state.live::before { border-color: var(--accept); background: var(--accept); }
.assistant-state.fail::before { border-color: var(--reject); background: var(--reject); }
.assistant-head .close { width: var(--tap); padding: 0; }
.assistant-head .settings-toggle { padding: 0 var(--space-3); font-size: var(--text-sm); }
.assistant-head .settings-toggle[hidden] { display: none; }
.assistant-head .settings-toggle[aria-expanded=true] { border-color: var(--ink); background: var(--pressed); font-weight: 700; }
/* Settings: a section of the panel under its header, never a dialog. */
.assistant-settings { display: flex; flex-direction: column; gap: var(--space-3); max-height: 60%; overflow-y: auto; padding: var(--space-3) var(--space-4); border-bottom: 1px solid var(--line); background: var(--pressed); font: var(--text-sm)/1.4 var(--font-ui); }
.assistant-settings[hidden] { display: none; }
.assistant-settings h3 { margin: 0; font: 700 var(--text-md)/1.3 var(--font-ui); }
.assistant-settings p { margin: 0; }
.assistant-settings label { display: flex; flex-direction: column; gap: var(--space-1); color: var(--muted); }
.assistant-settings select { width: 100%; color: var(--ink); background: var(--paper); }
.assistant-settings .actions { display: flex; flex-wrap: wrap; gap: var(--space-2); }
.assistant-forgot { display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-2) var(--space-3); padding: var(--space-2) var(--space-3); border: 1px dashed var(--edge); border-radius: var(--radius); }
.assistant-forgot > p { flex: 1 1 12rem; }
.assistant-context { display: flex; flex-wrap: wrap; gap: var(--space-2); align-items: center; padding: var(--space-2) var(--space-4); border-bottom: 1px solid var(--line); color: var(--muted); font: var(--text-sm)/1.4 var(--font-ui); }
.assistant-accounts { display: flex; flex-wrap: wrap; gap: var(--space-1) var(--space-3); padding: var(--space-2) var(--space-4); border-bottom: 1px solid var(--line); color: var(--muted); font: var(--text-sm)/1.4 var(--font-ui); }
.context-chip { display: inline-flex; align-items: center; max-width: 100%; min-height: var(--space-6); padding: 0 var(--space-2); border: 1px solid var(--edge); border-radius: var(--radius); color: var(--ink); }
.context-chip > span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.context-chip > button { flex: none; width: var(--tap); min-height: var(--space-6); margin-right: calc(-1 * var(--space-2)); padding: 0; border: 0; }
.assistant-log { flex: 1; min-height: 0; overflow-y: auto; overscroll-behavior: contain; display: flex; flex-direction: column; gap: var(--space-3); padding: var(--space-4); }
.assistant-log > p { margin: 0; }
.turn-user { align-self: flex-end; max-width: 90%; padding: var(--space-2) var(--space-3); border-radius: var(--radius); background: var(--pressed); white-space: pre-wrap; }
.turn-about { display: block; color: var(--muted); font-size: var(--text-xs); }
.answer { font: var(--text-md)/1.6 var(--font-prose); }
.answer > * { margin: 0 0 var(--space-3); }
.answer > :last-child { margin-bottom: 0; }
.answer ul, .answer ol { padding-left: var(--space-5); }
.answer blockquote { padding-left: var(--space-3); border-left: 3px solid var(--edge); }
.answer code { padding: 0 var(--space-1); border: 1px solid var(--line); border-radius: var(--space-1); font: .9em var(--font-code); }
.assistant-note { color: var(--muted); font: var(--text-sm)/1.45 var(--font-ui); }
.activity { display: flex; flex-wrap: wrap; gap: var(--space-2); margin: 0; padding: 0; list-style: none; }
.activity li { display: inline-flex; align-items: center; gap: var(--space-2); min-height: var(--space-6); padding: 0 var(--space-3); border: 1px solid var(--line); border-radius: var(--space-4); color: var(--muted); font: var(--text-sm)/1.3 var(--font-ui); }
.activity li::before { content: '✓'; color: var(--accept); font-weight: 700; }
.activity li.running::before { content: ''; width: var(--space-3); height: var(--space-3); border: 2px solid var(--edge); border-top-color: var(--ink); border-radius: 50%; animation: assistant-spin .8s linear infinite; }
.activity li.failed { border-color: var(--reject); color: var(--reject); }
.activity li.failed::before { content: '!'; color: var(--reject); }
@keyframes assistant-spin { to { transform: rotate(360deg); } }
.assistant-result { display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-2) var(--space-3); padding: var(--space-3); border: 1px solid var(--accept); border-left-width: var(--space-1); border-radius: var(--radius); background: var(--accept-bg); font: var(--text-sm)/1.4 var(--font-ui); }
.assistant-result > span { flex: 1 1 10rem; }
.assistant-log [role=alert] { margin: 0; }
.quick { display: flex; flex-direction: column; gap: var(--space-2); }
.quick > p { margin: 0 0 var(--space-2); color: var(--muted); font: var(--text-sm)/1.45 var(--font-ui); }
.quick > button { text-align: left; border-radius: var(--tap); }
.connect { display: flex; flex-direction: column; gap: var(--space-3); }
.connect h3 { margin: 0; }
.connect p { margin: 0; }
.connect .code { padding: var(--space-3); border: 1px solid var(--edge); border-radius: var(--radius); text-align: center; font: 700 var(--text-xl)/1.3 var(--font-code); letter-spacing: .1em; user-select: all; }
.connect .link-button { display: flex; align-items: center; justify-content: center; min-height: var(--tap); border: 1px solid var(--accept); border-radius: var(--radius); background: var(--accept); color: var(--paper); font-weight: 600; text-decoration: none; }
.assistant form { display: flex; gap: var(--space-2); align-items: flex-end; padding: var(--space-3) var(--space-4) max(var(--space-3), env(safe-area-inset-bottom)); border-top: 1px solid var(--line); }
.assistant form[hidden] { display: none; }
.assistant textarea { flex: 1 1 auto; min-width: 0; max-height: 30vh; padding: var(--space-2) var(--space-3); resize: none; }
.assistant form button { flex: none; }
.assistant-foot { display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-2) var(--space-3); padding: 0 var(--space-4) var(--space-3); color: var(--muted); font: var(--text-xs)/1.4 var(--font-ui); }
.assistant-foot[hidden] { display: none; }
.assistant-foot button { min-height: var(--tap); padding: 0 var(--space-3); font-size: var(--text-sm); }
article > .ask-assistant { float: right; margin: calc(-1 * var(--space-2)) calc(-1 * var(--space-2)) var(--space-2) var(--space-2); padding: 0 var(--space-3); border-color: transparent; color: var(--muted); font-size: var(--text-sm); }
article.flash { outline: 3px solid var(--accept); outline-offset: var(--space-1); }

/* Below 75em: a bottom sheet over the page, which keeps its scroll behind it. */
@media (max-width: 74.99em) {
  .assistant { left: 0; right: 0; bottom: 0; height: min(88dvh, 100dvh - var(--space-7)); border-top: 1px solid var(--edge); border-radius: var(--space-4) var(--space-4) 0 0; box-shadow: 0 calc(-1 * var(--space-1)) var(--space-5) rgb(0 0 0 / .25); }
  .assistant-head { padding-top: var(--space-4); }
  .assistant-head::before { content: ''; position: absolute; top: var(--space-2); left: calc(50% - var(--space-5)); width: var(--space-7); height: var(--space-1); border-radius: var(--space-1); background: var(--edge); }
}
/* Phone: the sticky decision bar owns the bottom edge, so the button floats above its height. */
@media (max-width: 40em) {
  .assistant-fab { bottom: calc(var(--tap) + 2 * var(--space-3) + max(var(--space-3), env(safe-area-inset-bottom)) + var(--space-3)); }
  main { padding-bottom: calc(2 * var(--tap) + var(--space-7) + env(safe-area-inset-bottom)); }
}
/* Wide screens: a side panel; the page column re-centres in the room left beside it. */
@media (min-width: 75em) {
  .assistant { top: 0; right: 0; bottom: 0; width: 26rem; border-left: 1px solid var(--line); }
  .assistant-scrim { display: none; }
  body.assistant-open { padding-right: 26rem; }
  /* No room beside the column for the section list: it goes back to the top row. */
  body.assistant-open { --nav-h: calc(var(--tap) + 2 * var(--space-1)); }
  body.assistant-open .section-nav { position: sticky; top: 0; left: auto; width: auto; max-height: none; margin: 0 calc(-1 * var(--gutter)); padding-top: env(safe-area-inset-top); border-bottom: 1px solid var(--line); overflow: visible; }
  body.assistant-open .section-nav ul { flex-direction: row; padding: var(--space-1) var(--gutter); overflow-x: auto; }
}
`;

export const ASSISTANT_JS = String.raw`
// ---- Assistant panel (src/adapters/engine-page.ts) ----
const ASSISTANT_MESSAGES = {
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
  model_unavailable: 'Ese modelo ya no está disponible para tu cuenta.',
};
// The efforts the server accepts, in the words of a writer.
const EFFORT_LABELS = { low: 'Rápido', medium: 'Equilibrado', high: 'A fondo' };
const FORGOTTEN = 'El asistente ya no recuerda los mensajes anteriores.';
// What the writer saw, per book, in this tab only (sessionStorage); never on the server.
const TRANSCRIPT_KEY = 'rewrite.assistant.';
const MAX_STORED_TURNS = 200;
const MAX_STORED_TEXT = 70000;
const QUICK_PROMPTS = ['Busca incoherencias en el libro', 'Resume los cambios pendientes', '¿Qué hallazgos debería revisar primero?'];
const SCENE_PROMPT = 'Analiza esta escena';
// What each kind of item the assistant creates is called in the result line.
const CREATED_KINDS = [
  ['proposal', 'cambio propuesto nuevo', 'cambios propuestos nuevos'],
  ['narrative_finding', 'hallazgo nuevo', 'hallazgos nuevos'],
  ['claim', 'afirmación nueva', 'afirmaciones nuevas'],
];
const PROPOSING = ['propose_revision', 'propose_findings', 'propose_claims'];

function plural(count, one, many) {
  return count + ' ' + (count === 1 ? one : many);
}

// "scenes/003-el-faro.md" reads "escena 3"; a name without a number reads as its words.
function sceneName(path) {
  const name = String(path).replace(/^scenes\//, '').replace(/\.md$/, '');
  const numbered = /^(\d{1,4})(?:[-_ ]|$)/.exec(name);
  return numbered ? 'escena ' + Number(numbered[1]) : name.replace(/[-_]+/g, ' ');
}

const counted = (one, many, none) => (step) => step.count === undefined ? none : plural(step.count, one, many);
const inScene = (prefix, none) => (step) => step.scene ? prefix + sceneName(step.scene) : none;
// Per tool: the label while it runs, once it ended well, and when it failed. Spanish
// titles of the MCP tools (src/adapters/mcp.ts) in the words of a person.
const TOOL_LABELS = {
  list_books: ['Consultando tus libros', counted('libro', 'libros', 'Libros consultados'), 'no se pudieron ver los libros'],
  list_scenes: ['Mirando las escenas', counted('escena', 'escenas', 'Escenas consultadas'), 'no se pudieron ver las escenas'],
  read_scene: [inScene('Leyendo ', 'Leyendo una escena'), inScene('Leída: ', 'Escena leída'), 'no se pudo leer la escena'],
  list_claims: ['Consultando afirmaciones', counted('afirmación', 'afirmaciones', 'Afirmaciones consultadas'), 'no se pudieron ver las afirmaciones'],
  propose_claims: ['Proponiendo afirmaciones', (s) => s.count === undefined ? 'Afirmaciones propuestas' : 'Propuestas ' + plural(s.count, 'afirmación', 'afirmaciones'), 'no se pudieron proponer las afirmaciones'],
  propose_revision: [inScene('Proponiendo un cambio en ', 'Proponiendo un cambio'), (s) => s.count === 0 ? 'Ese cambio ya estaba propuesto' : 'Propuesto 1 cambio', 'no se pudo proponer el cambio'],
  list_proposals: ['Consultando cambios propuestos', counted('cambio propuesto', 'cambios propuestos', 'Cambios consultados'), 'no se pudieron ver los cambios'],
  get_proposal: ['Leyendo un cambio propuesto', 'Cambio propuesto leído', 'no se pudo leer el cambio'],
  inspect_continuity: ['Revisando la continuidad', counted('posible problema', 'posibles problemas', 'Continuidad revisada'), 'no se pudo revisar la continuidad'],
  list_findings: ['Consultando hallazgos', counted('hallazgo', 'hallazgos', 'Hallazgos consultados'), 'no se pudieron ver los hallazgos'],
  get_analysis_guide: ['Leyendo la guía de análisis', 'Guía de análisis leída', 'no se pudo leer la guía'],
  propose_findings: ['Proponiendo hallazgos', (s) => s.count === undefined ? 'Hallazgos propuestos' : 'Propuestos ' + plural(s.count, 'hallazgo', 'hallazgos'), 'no se pudieron proponer los hallazgos'],
};

function activityLabel(step) {
  // Own properties only: a tool called "constructor" gets the generic label.
  const labels = Object.hasOwn(TOOL_LABELS, step.name) ? TOOL_LABELS[step.name] : null;
  const pick = (label) => typeof label === 'function' ? label(step) : label;
  if (step.phase === 'start') return (labels ? pick(labels[0]) : 'Usando ' + step.name) + '…';
  if (!step.ok) return 'Error: ' + (labels ? labels[2] : step.name);
  return labels ? pick(labels[1]) : step.name;
}

// Inline marks: **strong**, *emphasis* or _emphasis_, and inline code. Text stays text.
function appendInline(parent, text) {
  const mark = /\*\*([^*\n]+)\*\*|\*([^*\s][^*\n]*)\*|(?:^|(?<=\s))_([^_\n]+)_(?=\s|$|[.,;:!?])|\x60([^\x60\n]+)\x60/g;
  let last = 0;
  for (let found = mark.exec(text); found; found = mark.exec(text)) {
    if (found.index > last) parent.append(text.slice(last, found.index));
    if (found[1] !== undefined) parent.append(el('strong', found[1]));
    else if (found[4] !== undefined) parent.append(el('code', found[4]));
    else parent.append(el('em', found[2] !== undefined ? found[2] : found[3]));
    last = found.index + found[0].length;
  }
  if (last < text.length) parent.append(text.slice(last));
}

// Paragraphs, bulleted and numbered lists, and quotes, as elements. Anything else is text.
function formatAnswer(text) {
  const blocks = [];
  let open = null;
  const block = (tag) => {
    if (!open || open.tagName !== tag) {
      open = { tagName: tag, node: el(tag) };
      blocks.push(open.node);
    }
    return open.node;
  };
  for (const line of String(text).split('\n')) {
    const bullet = /^\s*[-*•]\s+(.*)$/.exec(line);
    const numbered = /^\s*\d{1,3}[.)]\s+(.*)$/.exec(line);
    const quoted = /^\s*>\s?(.*)$/.exec(line);
    if (!line.trim()) { open = null; continue; }
    if (bullet || numbered) {
      const item = el('li');
      appendInline(item, (bullet || numbered)[1]);
      block(bullet ? 'ul' : 'ol').append(item);
    } else if (quoted) {
      const quote = block('blockquote');
      if (quote.childNodes && quote.childNodes.length) quote.append(' ');
      appendInline(quote, quoted[1]);
    } else {
      const paragraph = block('p');
      if (paragraph.childNodes && paragraph.childNodes.length) paragraph.append(el('br'));
      appendInline(paragraph, line);
    }
  }
  return blocks;
}

const assistantState = {
  status: { state: 'unknown' }, turns: [], running: false, notice: '', poll: null, item: null, queued: false, opener: null,
  // The book whose transcript the panel shows.
  book: null,
  turnsSent: 0,
  settings: { open: false, loading: false, data: null, error: '', saved: false },
};

// ---- The visible transcript, kept per book in sessionStorage ----

function transcriptStore() {
  try { return window.sessionStorage || null; } catch (error) { return null; }
}

const storableText = (value) => typeof value === 'string' && value.length <= MAX_STORED_TEXT;

// Only what the page showed: text, the item label, and the validated fields of each step.
function storedTurn(turn) {
  if (!turn || typeof turn !== 'object') return null;
  if (turn.role === 'user' && storableText(turn.text)) return { role: 'user', text: turn.text, about: storableText(turn.about) ? turn.about : '' };
  if ((turn.role === 'error' || turn.role === 'note') && storableText(turn.text)) return { role: turn.role, text: turn.text };
  if (turn.role !== 'assistant' || !storableText(turn.text) || !Array.isArray(turn.steps)) return null;
  const steps = [];
  for (const step of turn.steps.slice(0, 100)) {
    if (!step || typeof step.name !== 'string' || !/^[A-Za-z0-9_]{1,128}$/.test(step.name)) continue;
    // A step still running when the turn ended did not finish.
    const done = { name: step.name, phase: 'end', ok: step.phase !== 'start' && step.ok === true };
    if (typeof step.scene === 'string' && step.scene.length <= 120) done.scene = step.scene;
    if (Number.isInteger(step.count) && step.count >= 0 && step.count <= 999) done.count = step.count;
    steps.push(done);
  }
  return { role: 'assistant', text: turn.text, phase: turn.phase === 'stopped' ? 'stopped' : 'done', steps };
}

function loadTranscript(book) {
  const store = transcriptStore();
  if (!store) return [];
  try {
    const value = JSON.parse(store.getItem(TRANSCRIPT_KEY + book) || '[]');
    return Array.isArray(value) ? value.slice(-MAX_STORED_TURNS).map(storedTurn).filter(Boolean) : [];
  } catch (error) {
    return [];
  }
}

function saveTranscript() {
  const store = transcriptStore();
  const book = assistantState.book;
  if (!store || !book) return;
  const turns = assistantState.turns.map(storedTurn).filter(Boolean).slice(-MAX_STORED_TURNS);
  try {
    if (turns.length) store.setItem(TRANSCRIPT_KEY + book, JSON.stringify(turns));
    else store.removeItem(TRANSCRIPT_KEY + book);
  } catch (error) { /* full or blocked: the panel keeps working without it */ }
}

function clearTranscripts() {
  const store = transcriptStore();
  if (!store) return;
  try {
    const keys = [];
    for (let i = 0; i < store.length; i++) {
      const key = store.key(i);
      if (key && key.startsWith(TRANSCRIPT_KEY)) keys.push(key);
    }
    for (const key of keys) store.removeItem(key);
  } catch (error) { /* nothing stored */ }
}

// The page selected another book: show that book's transcript.
function syncBook() {
  const book = view && view.book ? view.book : null;
  if (book === assistantState.book || assistantState.running) return;
  const first = assistantState.book === null;
  assistantState.book = book;
  // A conversation started before the page knew its book belongs to the first one.
  if (first && book && assistantState.turns.length) saveTranscript();
  else assistantState.turns = book ? loadTranscript(book) : [];
  noteForgotten();
}

// The page shows an earlier conversation the engine process no longer holds (it stopped
// after a while unused, or restarted): say so once, before anything new.
function noteForgotten() {
  const status = assistantState.status;
  const turns = assistantState.turns;
  if (assistantState.running || status.state !== 'connected' || status.conversation || !turns.length) return;
  if (turns[turns.length - 1].role === 'note') return;
  if (!turns.some((turn) => turn.role === 'user')) return;
  turns.push({ role: 'note', text: FORGOTTEN });
  saveTranscript();
}
const panel = {};

function assistantButton(label, className, onClick) {
  const node = el('button', label, className);
  node.type = 'button';
  node.addEventListener('click', onClick);
  return node;
}

async function engineApi(method, path, body) {
  const token = await window.Clerk.session.getToken();
  return fetch('/review/api/engine' + path, {
    method,
    headers: Object.assign({ authorization: 'Bearer ' + token }, body === undefined ? {} : { 'content-type': 'application/json' }),
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

function assistantMessage(code) {
  return ASSISTANT_MESSAGES[code] || ASSISTANT_MESSAGES.engine_unavailable;
}

async function failureOf(res) {
  let code = 'engine_unavailable';
  try { code = (await res.json()).error; } catch (error) { /* keep the fixed code */ }
  return assistantMessage(code);
}

// The ids of what the page shows, by kind, to tell later what the assistant created.
function itemIds(queue) {
  const ids = { proposal: [], narrative_finding: [], claim: [] };
  if (!queue) return ids;
  for (const p of queue.proposals || []) ids.proposal.push(p.proposal.proposal_id);
  for (const f of queue.finding_views || []) ids.narrative_finding.push(f.finding_id);
  for (const c of queue.claims || []) ids.claim.push(c.claim_id);
  return ids;
}

// What goes to the server about the page: ids only; the server writes the line for the model.
function pageContext() {
  if (!view || !view.book) return undefined;
  const context = { book_id: view.book };
  if (assistantState.item) context.item = { kind: assistantState.item.kind, id: assistantState.item.id };
  return context;
}

async function refreshAssistantStatus() {
  const turnsBefore = assistantState.turnsSent;
  const res = await engineApi('GET', '/status');
  if (res.ok) {
    const status = await res.json();
    // A turn sent meanwhile started a conversation this answer could not know of yet.
    const sent = assistantState.turnsSent !== turnsBefore && status.state === 'connected';
    assistantState.status = sent ? Object.assign({}, status, { conversation: true }) : status;
    noteForgotten();
  }
  // The engine does not exist for someone who cannot use a book yet.
  else if (res.status === 404) assistantState.status = { state: 'unavailable' };
  if (assistantState.status.state !== 'pending' && assistantState.poll) {
    clearInterval(assistantState.poll);
    assistantState.poll = null;
  }
  if (assistantState.status.state !== 'connected' && assistantState.settings.open) setSettingsOpen(false);
  renderAssistant();
}

async function connectAssistant() {
  assistantState.notice = '';
  assistantState.status = { state: 'connecting' };
  renderAssistant();
  const res = await engineApi('POST', '/login');
  if (!res.ok) {
    assistantState.notice = await failureOf(res);
    assistantState.status = { state: 'disconnected' };
    return renderAssistant();
  }
  const login = await res.json();
  assistantState.status = { state: 'pending', user_code: login.user_code, verification_uri: login.verification_uri };
  if (!assistantState.poll) assistantState.poll = setInterval(refreshAssistantStatus, 3000);
  renderAssistant();
}

async function disconnectAssistant() {
  await engineApi('DELETE', '/credential');
  assistantState.turns = [];
  assistantState.notice = '';
  clearTranscripts();
  setSettingsOpen(false);
  await refreshAssistantStatus();
}

// Clears the engine's history and what the page shows, without logging out of ChatGPT.
async function newConversation() {
  if (assistantState.running) return;
  const res = await engineApi('POST', '/reset');
  if (!res.ok) {
    assistantState.settings.error = await failureOf(res);
    renderSettings();
    return;
  }
  assistantState.turns = [];
  assistantState.notice = '';
  saveTranscript();
  setSettingsOpen(false);
  renderAssistant();
  if (panel.input) panel.input.focus();
}

// ---- Settings: model, reasoning effort, new conversation, disconnect ----

async function loadSettings() {
  const settings = assistantState.settings;
  settings.loading = true;
  settings.error = '';
  renderSettings();
  try {
    const res = await engineApi('GET', '/settings');
    if (res.ok) settings.data = await res.json();
    else settings.error = await failureOf(res);
  } catch (error) {
    settings.error = ASSISTANT_MESSAGES.engine_unavailable;
  }
  settings.loading = false;
  renderSettings();
}

async function saveSettings(change) {
  const settings = assistantState.settings;
  settings.error = '';
  settings.saved = false;
  try {
    const res = await engineApi('PUT', '/settings', change);
    if (res.ok) {
      settings.data = await res.json();
      settings.saved = true;
    } else {
      settings.error = await failureOf(res);
    }
  } catch (error) {
    settings.error = ASSISTANT_MESSAGES.engine_unavailable;
  }
  renderSettings();
}

function setSettingsOpen(open) {
  const settings = assistantState.settings;
  settings.open = open;
  settings.saved = false;
  if (!panel.settings) return;
  panel.settings.hidden = !open;
  panel.settingsToggle.setAttribute('aria-expanded', String(open));
  if (open) loadSettings();
}

function settingsSelect(label, options, value, onChange) {
  const field = el('label', label);
  const select = el('select');
  for (const [optionValue, text] of options) {
    const option = el('option', text);
    option.value = optionValue;
    select.append(option);
  }
  select.value = value;
  select.addEventListener('change', () => onChange(select.value));
  field.append(select);
  return { field, select };
}

// Rebuilt only when the settings change, never on each streamed delta, so an open
// list keeps its focus.
function renderSettings() {
  const box = panel.settings;
  if (!box) return;
  const settings = assistantState.settings;
  const nodes = [el('h3', 'Ajustes')];
  if (settings.error) {
    const alert = el('p', settings.error);
    alert.setAttribute('role', 'alert');
    nodes.push(alert);
  }
  const data = settings.data;
  if (settings.loading && !data) nodes.push(el('p', 'Cargando los modelos de tu cuenta…', 'assistant-note'));
  else if (data && data.models.length === 0) nodes.push(el('p', 'Tu cuenta no tiene ningún modelo disponible aquí.', 'assistant-note'));
  else if (data) {
    const model = settingsSelect('Modelo', data.models.map((m) => [m.id, m.name]), data.model || '', (id) => saveSettings({ model: id }));
    const current = data.models.find((m) => m.id === data.model);
    const efforts = (data.efforts || []).filter((e) => Object.hasOwn(EFFORT_LABELS, e)).map((e) => [e, EFFORT_LABELS[e]]);
    const effort = settingsSelect('Razonamiento', efforts, data.effort, (value) => saveSettings({ effort: value }));
    effort.select.disabled = !current || !current.reasoning;
    nodes.push(model.field, effort.field);
    if (effort.select.disabled) nodes.push(el('p', 'Este modelo no tiene niveles de razonamiento.', 'assistant-note'));
    if (settings.saved) nodes.push(el('p', 'Se usará en tu próximo mensaje.', 'assistant-note'));
  }
  const actions = el('div', undefined, 'actions');
  const fresh = assistantButton('Nueva conversación', '', newConversation);
  fresh.disabled = assistantState.running;
  actions.append(fresh, assistantButton('Desconectar ChatGPT', 'reject', disconnectAssistant));
  nodes.push(actions);
  panel.newConversation = fresh;
  box.replaceChildren(...nodes);
}

function parseEvents(buffer, onEvent) {
  let index;
  while ((index = buffer.indexOf('\n\n')) >= 0) {
    const block = buffer.slice(0, index);
    buffer = buffer.slice(index + 2);
    // Lines end only at CR, LF or CRLF (the SSE rule): U+2028 inside JSON is text.
    let event = null;
    let data = null;
    for (const line of block.split(/\r\n|\r|\n/)) {
      if (line.startsWith('event: ')) event = line.slice(7);
      else if (line.startsWith('data: ')) data = line.slice(6);
    }
    if (event !== null && data !== null) onEvent(event, JSON.parse(data));
  }
  return buffer;
}

function applyTool(answer, data) {
  const step = data.call === undefined ? null : answer.steps.find((s) => s.call === data.call);
  if (step) Object.assign(step, data);
  else answer.steps.push(Object.assign({}, data));
}

async function sendAssistant(text) {
  if (assistantState.running || !String(text).trim()) return;
  assistantState.running = true;
  assistantState.turnsSent += 1;
  assistantState.notice = '';
  const item = assistantState.item;
  assistantState.turns.push({ role: 'user', text, about: item ? item.label : '' });
  const answer = { role: 'assistant', text: '', steps: [], phase: 'thinking', before: itemIds(latestQueue) };
  assistantState.turns.push(answer);
  saveTranscript();
  renderAssistant();
  try {
    const context = pageContext();
    const res = await engineApi('POST', '/prompt', context ? { text, context } : { text });
    if (!res.ok) {
      assistantState.turns.pop();
      assistantState.turns.push({ role: 'error', text: await failureOf(res) });
      if (res.status === 409) await refreshAssistantStatus();
      return;
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) {
      buffer = parseEvents(buffer + decoder.decode(chunk.value, { stream: true }), (event, data) => {
        if (event === 'delta') { answer.text += data.text; answer.phase = 'streaming'; }
        if (event === 'tool') applyTool(answer, data);
        if (event === 'done' && data.aborted) answer.phase = 'stopped';
        if (event === 'error') {
          assistantState.turns.push({ role: 'error', text: assistantMessage(data.code) });
          if (data.code === 'reconnect') assistantState.status = { state: 'reconnect' };
        }
        queueAssistantRender();
      });
    }
  } catch (error) {
    assistantState.turns.push({ role: 'error', text: ASSISTANT_MESSAGES.engine_unavailable });
  } finally {
    if (answer.phase !== 'stopped') answer.phase = 'done';
    // Something was proposed: say so, and point at it once the page shows it.
    if (answer.steps.some((s) => PROPOSING.includes(s.name) && s.phase === 'end' && s.ok && s.count !== 0)) {
      answer.created = { waiting: true, found: [] };
      revealCreated();
    }
    assistantState.running = false;
    // The engine process now holds this conversation.
    if (assistantState.status.state === 'connected') assistantState.status = Object.assign({}, assistantState.status, { conversation: true });
    saveTranscript();
    renderAssistant();
  }
}

async function stopAssistant() {
  await engineApi('POST', '/abort');
}

// Called by the review page each time it shows new data.
function revealCreated() {
  const now = itemIds(latestQueue);
  for (const turn of assistantState.turns) {
    if (!turn.created || !turn.created.waiting) continue;
    const found = [];
    for (const [kind] of CREATED_KINDS) {
      const fresh = now[kind].filter((id) => !turn.before[kind].includes(id));
      if (fresh.length) found.push({ kind, ids: fresh });
    }
    if (found.length) turn.created = { waiting: false, found };
  }
}

function showInPage(kind, id) {
  const card = [...app.querySelectorAll('[data-item]')].find((node) => node.getAttribute('data-item') === kind + ':' + id);
  if (!card) return;
  const section = card.closest('section[id^="sec-"]');
  if (section && section.fold) section.fold.setOpen(true);
  // On a phone the sheet covers the page: close it so the card can be seen.
  if (!window.matchMedia('(min-width: 75em)').matches) setAssistantOpen(false, true);
  card.scrollIntoView({ behavior: scrollBehavior(), block: 'center' });
  card.tabIndex = -1;
  card.focus({ preventScroll: true });
  card.classList.add('flash');
  setTimeout(() => card.classList.remove('flash'), 2000);
}

function stepList(steps) {
  const list = el('ul', undefined, 'activity');
  list.setAttribute('aria-label', 'Lo que ha hecho el asistente');
  for (const step of steps) {
    list.append(el('li', activityLabel(step), step.phase === 'start' ? 'running' : step.ok ? '' : 'failed'));
  }
  return list;
}

function createdLine(created) {
  const box = el('div', undefined, 'assistant-result');
  if (created.waiting) {
    box.append(el('span', 'Lo propuesto aparecerá en la página en unos segundos.'));
    return [box];
  }
  return created.found.map(({ kind, ids }) => {
    const [, one, many] = CREATED_KINDS.find((k) => k[0] === kind);
    const line = el('div', undefined, 'assistant-result');
    line.append(el('span', plural(ids.length, one, many)), assistantButton('Ver en la página', '', () => showInPage(kind, ids[0])));
    return line;
  });
}

function connectView() {
  const box = el('div', undefined, 'connect');
  const status = assistantState.status;
  if (status.state === 'unavailable') {
    box.append(el('h3', 'Primero necesitas un libro'), el('p', 'El asistente trabaja sobre tus libros. Crea uno o pide acceso a uno y vuelve a abrirlo.'));
    return box;
  }
  if (status.state === 'pending') {
    box.append(
      el('h3', 'Escribe este código en OpenAI'),
      el('p', 'Abre la página de OpenAI, inicia sesión con tu cuenta de ChatGPT y escribe el código. Después vuelve a esta pestaña: el panel se actualizará solo.'),
      el('strong', status.user_code || '…', 'code'),
    );
    const link = el('a', 'Abrir OpenAI', 'link-button');
    link.setAttribute('href', status.verification_uri);
    link.setAttribute('target', '_blank');
    link.setAttribute('rel', 'noopener noreferrer');
    box.append(link, el('p', 'Esperando a que confirmes en OpenAI…', 'assistant-note'), assistantButton('Pedir otro código', '', connectAssistant),
      el('p', 'El código caduca en 15 minutos. Escríbelo solo en auth.openai.com.', 'assistant-note'));
    return box;
  }
  if (status.state === 'connecting' || status.state === 'unknown') {
    box.append(el('p', 'Conectando…', 'assistant-note'));
    return box;
  }
  // Two accounts, said before any code (issue #99): RE;write is enough for the page,
  // the assistant also needs the writer's own ChatGPT, connected at OpenAI.
  box.append(
    el('h3', status.state === 'reconnect' ? 'Vuelve a conectar ChatGPT' : 'Qué necesitas'),
    el('p', 'Tu cuenta de RE;write basta para crear libros, importar capítulos y revisar sugerencias.'),
    el('p', 'Para hablar con el asistente aquí también necesitas tu propia cuenta de ChatGPT. Se conecta con un código en la página de OpenAI. Nunca escribas tu contraseña en RE;write.'),
    assistantButton('Conectar ChatGPT', 'accept', connectAssistant),
    el('p', 'El asistente usa tu suscripción de ChatGPT: puede leer tus libros y proponer cambios; aceptar o rechazar sigue siendo cosa tuya. El texto que lea de tus libros se envía a OpenAI con tu cuenta.', 'assistant-note'),
    el('p', 'También puedes usar RE;write desde tu propio ChatGPT con el conector de RE;write.', 'assistant-note'),
  );
  if (status.state === 'reconnect') box.append(assistantButton('Desconectar', 'reject', disconnectAssistant));
  return box;
}

function quickView() {
  const box = el('div', undefined, 'quick');
  box.append(el('p', 'Pregunta por lo que tienes delante. El asistente lee tu libro y propone; aceptar o rechazar sigue siendo cosa tuya.'));
  const prompts = (openScene ? [SCENE_PROMPT] : []).concat(QUICK_PROMPTS);
  for (const prompt of prompts) {
    box.append(assistantButton(prompt, '', () => {
      // A quick action only fills the prompt; the scene it names becomes the item.
      if (prompt === SCENE_PROMPT && openScene) setAssistantItem({ kind: 'scene', id: openScene.file, label: 'Escena: ' + sceneName(openScene.file) });
      panel.input.value = prompt;
      fitInput();
      panel.input.focus();
    }));
  }
  return box;
}

function turnView(turn) {
  if (turn.role === 'user') {
    const bubble = el('div', undefined, 'turn-user');
    bubble.setAttribute('aria-label', 'Tú');
    if (turn.about) bubble.append(el('span', 'Sobre: ' + turn.about, 'turn-about'));
    bubble.append(turn.text);
    return [bubble];
  }
  if (turn.role === 'error') {
    const alert = el('p', turn.text);
    alert.setAttribute('role', 'alert');
    return [alert];
  }
  if (turn.role === 'note') {
    const box = el('div', undefined, 'assistant-forgot');
    box.append(el('p', turn.text, 'assistant-note'), assistantButton('Nueva conversación', '', newConversation));
    return [box];
  }
  const nodes = [];
  if (turn.steps.length) nodes.push(stepList(turn.steps));
  if (turn.text) {
    const answer = el('div', undefined, 'answer');
    answer.setAttribute('aria-label', 'Asistente');
    answer.append(...formatAnswer(turn.text));
    nodes.push(answer);
  } else if (turn.phase === 'thinking') {
    nodes.push(el('p', 'Pensando…', 'assistant-note'));
  }
  if (turn.phase === 'stopped') nodes.push(el('p', 'Respuesta detenida.', 'assistant-note'));
  if (turn.created) nodes.push(...createdLine(turn.created));
  return nodes;
}

const STATE_WORDS = { connected: 'Conectado', pending: 'Esperando el código', connecting: 'Conectando…', reconnect: 'Sin conexión', disconnected: 'Sin conectar', unavailable: 'No disponible', unknown: '' };

function headState() {
  if (assistantState.running) {
    const last = assistantState.turns[assistantState.turns.length - 1];
    return [last && last.phase === 'streaming' ? 'Escribiendo…' : 'Pensando…', 'live'];
  }
  const last = assistantState.turns[assistantState.turns.length - 1];
  if (last && last.role === 'error') return ['Error', 'fail'];
  if (last && last.phase === 'stopped') return ['Detenida', ''];
  const state = assistantState.status.state;
  return [STATE_WORDS[state] || '', state === 'connected' ? 'live' : ''];
}

function setAssistantItem(item) {
  assistantState.item = item;
  renderAssistant();
}

function renderAssistant() {
  assistantState.queued = false;
  if (!panel.root) return;
  const [word, tone] = headState();
  panel.state.textContent = word;
  panel.state.className = 'assistant-state' + (tone ? ' ' + tone : '');

  const chips = [el('span', 'Libro:')];
  const book = el('span', undefined, 'context-chip');
  book.append(el('span', currentBookTitle || '—'));
  chips.push(book);
  if (assistantState.item) {
    const chip = el('span', undefined, 'context-chip');
    const remove = assistantButton('✕', '', () => setAssistantItem(null));
    remove.setAttribute('aria-label', 'Quitar la referencia');
    chip.append(el('span', assistantState.item.label), remove);
    chips.push(chip);
  }
  panel.context.replaceChildren(...chips);
  panel.accounts.replaceChildren(
    el('span', 'RE;write: sesión iniciada'),
    el('span', 'ChatGPT: ' + (assistantState.status.state === 'connected' ? 'conectado' : 'sin conectar')),
  );

  const connected = assistantState.status.state === 'connected';
  const nodes = [];
  if (assistantState.notice) {
    const alert = el('p', assistantState.notice);
    alert.setAttribute('role', 'alert');
    nodes.push(alert);
  }
  if (!connected) nodes.push(connectView());
  else if (!assistantState.turns.length) nodes.push(quickView());
  for (const turn of assistantState.turns) nodes.push(...turnView(turn));
  // Follow the answer only when the reader is already at the end of the conversation.
  const log = panel.log;
  const atEnd = log.scrollHeight - log.scrollTop - log.clientHeight < 48;
  log.replaceChildren(...nodes);
  if (atEnd) log.scrollTop = log.scrollHeight;

  panel.form.hidden = !connected;
  panel.foot.hidden = !connected;
  panel.settingsToggle.hidden = !connected;
  if (panel.newConversation) panel.newConversation.disabled = assistantState.running;
  panel.input.disabled = false;
  panel.submit.textContent = assistantState.running ? 'Detener' : 'Enviar';
  panel.submit.className = assistantState.running ? 'reject' : 'accept';
}

// Deltas arrive faster than a screen refreshes: render once per frame at most.
function queueAssistantRender() {
  if (assistantState.queued) return;
  assistantState.queued = true;
  if (window.requestAnimationFrame) window.requestAnimationFrame(renderAssistant);
  else renderAssistant();
}

function setAssistantOpen(open, quiet) {
  if (!panel.root || panel.root.hidden === !open) return;
  // The page column changes width beside the panel: keep the card being read in place.
  const anchor = viewportAnchor();
  panel.root.hidden = !open;
  panel.scrim.hidden = !open;
  document.body.classList.toggle('assistant-open', open);
  for (const control of [panel.fab, panel.toggle]) if (control) control.setAttribute('aria-expanded', String(open));
  const anchored = anchor && document.getElementById(anchor.id);
  if (anchored) window.scrollBy(0, anchored.getBoundingClientRect().top - anchor.top);
  if (open) {
    // Each opening asks again: the engine process may have stopped since.
    refreshAssistantStatus().catch(() => {});
    renderAssistant();
    if (!quiet) (assistantState.status.state === 'connected' ? panel.input : panel.title).focus();
  } else if (!quiet && panel.opener && panel.opener.isConnected) {
    panel.opener.focus();
  }
}

function openAssistant(opener) {
  panel.opener = opener || document.activeElement;
  setAssistantOpen(true);
}

// "Preguntar al asistente" on a card: the item becomes the reference and the draft fills
// an empty prompt; text the writer already typed is kept.
function askAssistantAbout(item, draft, opener) {
  setAssistantItem(item);
  if (!panel.input.value.trim()) panel.input.value = draft;
  openAssistant(opener);
  fitInput();
  if (assistantState.status.state === 'connected') panel.input.focus();
}

function fitInput() {
  const input = panel.input;
  if (!input || !input.style) return;
  input.style.height = 'auto';
  input.style.height = input.scrollHeight + 2 + 'px';
}

function buildAssistant() {
  const toggle = document.getElementById('assistant-toggle');
  const fab = assistantButton('', 'assistant-fab', () => openAssistant(fab));
  fab.append(el('span', 'Asistente'));
  fab.setAttribute('aria-label', 'Asistente');
  fab.setAttribute('aria-controls', 'assistant');
  fab.setAttribute('aria-expanded', 'false');
  const scrim = el('div', undefined, 'assistant-scrim');
  scrim.hidden = true;
  scrim.addEventListener('click', () => setAssistantOpen(false));
  const root = el('aside', undefined, 'assistant');
  root.id = 'assistant';
  root.setAttribute('aria-label', 'Asistente');
  root.hidden = true;
  const head = el('div', undefined, 'assistant-head');
  const title = el('h2', 'Asistente');
  title.tabIndex = -1;
  const state = el('span', '', 'assistant-state');
  const close = assistantButton('✕', 'close', () => setAssistantOpen(false));
  close.setAttribute('aria-label', 'Cerrar el asistente');
  const settingsToggle = assistantButton('Ajustes', 'settings-toggle', () => setSettingsOpen(!assistantState.settings.open));
  settingsToggle.setAttribute('aria-controls', 'assistant-settings');
  settingsToggle.setAttribute('aria-expanded', 'false');
  settingsToggle.hidden = true;
  head.append(title, state, settingsToggle, close);
  const settings = el('div', undefined, 'assistant-settings');
  settings.id = 'assistant-settings';
  settings.setAttribute('aria-label', 'Ajustes del asistente');
  settings.hidden = true;
  const context = el('div', undefined, 'assistant-context');
  context.setAttribute('aria-label', 'Sobre qué preguntas');
  const accounts = el('div', undefined, 'assistant-accounts');
  accounts.setAttribute('aria-label', 'Tus cuentas');
  const log = el('div', undefined, 'assistant-log');
  log.setAttribute('role', 'log');
  log.setAttribute('aria-label', 'Conversación');
  const form = el('form');
  const input = el('textarea');
  input.rows = 2;
  input.maxLength = 8000;
  input.placeholder = 'Pregunta por tu libro';
  input.setAttribute('aria-label', 'Mensaje para el asistente');
  const submit = el('button', 'Enviar', 'accept');
  submit.type = 'submit';
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    if (assistantState.running) return stopAssistant();
    const text = input.value;
    if (!text.trim()) return undefined;
    input.value = '';
    fitInput();
    return sendAssistant(text);
  });
  // The field grows with its text, up to the CSS max-height.
  input.addEventListener('input', () => fitInput());
  // Enter sends, Shift+Enter starts a new line.
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      if (!assistantState.running) form.requestSubmit();
    }
  });
  form.append(input, submit);
  const foot = el('div', undefined, 'assistant-foot');
  foot.append(el('span', 'Lo que ves aquí se guarda solo en esta pestaña. Modelo, razonamiento y nueva conversación están en Ajustes.'));
  root.append(head, settings, context, accounts, log, form, foot);
  root.addEventListener('keydown', (event) => { if (event.key === 'Escape') setAssistantOpen(false); });
  document.body.append(scrim, root, fab);
  if (toggle) toggle.addEventListener('click', () => (root.hidden ? openAssistant(toggle) : setAssistantOpen(false)));
  Object.assign(panel, { root, scrim, fab, toggle, title, state, settingsToggle, settings, context, accounts, log, form, input, submit, foot });
  // The floating button shrinks to its icon once the reader scrolls down, and moves up
  // over any accept/reject bar that passes under it, stuck or not.
  let placing = false;
  const place = () => {
    placing = false;
    fab.classList.toggle('compact', window.scrollY > 80);
    placeFab();
  };
  const queuePlace = () => {
    if (placing) return;
    placing = true;
    if (window.requestAnimationFrame) window.requestAnimationFrame(place);
    else place();
  };
  window.addEventListener('scroll', queuePlace, { passive: true });
  window.addEventListener('resize', queuePlace);
}

function placeFab() {
  const fab = panel.fab;
  if (!fab || !fab.style) return;
  fab.style.transform = '';
  const rest = fab.getBoundingClientRect();
  let lift = 0;
  for (const bar of app.querySelectorAll('.decision')) {
    const box = bar.getBoundingClientRect();
    const overlaps = box.bottom > rest.top - 8 && box.top < rest.bottom + 8 && box.right > rest.left && box.left < rest.right;
    if (overlaps) lift = Math.max(lift, rest.bottom - box.top + 12);
  }
  if (lift) fab.style.transform = 'translateY(' + -Math.round(lift) + 'px)';
}

// The review page calls these: start once the writer is signed in, pageChanged after it shows new data.
assistant = {
  ask: askAssistantAbout,
  pageChanged() {
    syncBook();
    revealCreated();
    placeFab();
    if (panel.root && !panel.root.hidden) renderAssistant();
  },
  start: startAssistant,
};

function startAssistant() {
  if (panel.root || !document.body.hasAttribute('data-assistant')) return;
  buildAssistant();
  syncBook();
  // /review/engine sends here with ?asistente=1: open the panel and tidy the address.
  const params = new URLSearchParams(window.location.search);
  if (params.get('asistente') === '1') {
    params.delete('asistente');
    const query = params.toString();
    window.history.replaceState(null, '', window.location.pathname + (query ? '?' + query : '') + window.location.hash);
    setAssistantOpen(true, true);
  }
}
`;
