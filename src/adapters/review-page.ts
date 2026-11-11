/**
 * The page a person uses to accept or reject. It holds no data: everything comes
 * from the review API after sign-in, and it is rendered with textContent, because
 * manuscripts and agent proposals are untrusted.
 */

function escapeAttribute(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

export function reviewHtml(issuer: string, publishableKey: string): string {
  const frontendApi = escapeAttribute(issuer.replace(/\/$/, ''));
  return `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="color-scheme" content="light dark">
<title>RE;write · Revisión</title>
<link rel="stylesheet" href="/review/app.css">
<script defer crossorigin="anonymous" src="${frontendApi}/npm/@clerk/ui@1/dist/ui.browser.js"></script>
<script defer crossorigin="anonymous" data-clerk-publishable-key="${escapeAttribute(publishableKey)}" src="${frontendApi}/npm/@clerk/clerk-js@6/dist/clerk.browser.js"></script>
<script defer src="/review/app.js"></script>
</head>
<body>
<header><h1>RE;write</h1><div id="user"></div></header>
<main id="app"><p>Cargando…</p></main>
</body>
</html>
`;
}

export function reviewCsp(issuer: string): string {
  const origin = new URL(issuer).origin;
  return [
    "default-src 'none'",
    `script-src 'self' ${origin} https://*.protect.clerk.com https://challenges.cloudflare.com`,
    // Clerk's components inject their own styles.
    "style-src 'self' 'unsafe-inline'",
    // Clerk's bot protection probes its own hosts on several ports.
    `connect-src 'self' ${origin} https://*.protect.clerk.com:*`,
    'img-src https://img.clerk.com data:',
    "font-src 'self' data:",
    "worker-src 'self' blob:",
    'frame-src https://challenges.cloudflare.com',
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join('; ');
}

export const REVIEW_CSS = `
/* Roles, scales and breakpoints are described in docs/design.md. */
:root {
  color-scheme: light dark;
  --ink: #1c1b19; --paper: #faf8f4; --muted: #625d54; --line: #d9d4ca; --edge: #8a8478;
  --accept: #1f6b45; --accept-bg: #e0e7df; --reject: #a32a2a; --reject-bg: #f0dfdc;
  --mark: #ffe066; --pressed: #e4e2de;
  --space-1: 4px; --space-2: 8px; --space-3: 12px; --space-4: 16px; --space-5: 24px; --space-6: 32px; --space-7: 48px;
  --text-xs: .8125rem; --text-sm: .875rem; --text-md: 1rem; --text-lg: 1.125rem; --text-xl: 1.375rem;
  --font-prose: Georgia, 'Times New Roman', serif;
  --font-ui: system-ui, -apple-system, 'Segoe UI', sans-serif;
  --font-code: ui-monospace, 'SF Mono', Menlo, Consolas, monospace;
  --measure: 46rem; --tap: 44px; --radius: 8px;
  --gutter: max(var(--space-4), env(safe-area-inset-left), env(safe-area-inset-right));
}
@media (prefers-color-scheme: dark) {
  :root {
    --ink: #ece8df; --paper: #1a1917; --muted: #a39d90; --line: #3a372f; --edge: #7d776b;
    --accept: #5fc08f; --accept-bg: #222d25; --reject: #ef8585; --reject-bg: #342624;
    --mark: #6b5600; --pressed: #2f2e2b;
  }
}

* { box-sizing: border-box; }
html { -webkit-text-size-adjust: 100%; text-size-adjust: 100%; }
/* overflow-wrap: anywhere lets a long word or URL break instead of widening the page. */
body { margin: 0; background: var(--paper); color: var(--ink); font: var(--text-md)/1.6 var(--font-prose); overflow-wrap: anywhere; }
header { display: flex; justify-content: space-between; align-items: center; gap: var(--space-3); padding: var(--space-2) max(var(--gutter), calc((100% - var(--measure)) / 2 + var(--gutter))); padding-top: max(var(--space-2), env(safe-area-inset-top)); border-bottom: 1px solid var(--line); }
#user { display: flex; align-items: center; justify-content: flex-end; min-width: var(--tap); min-height: var(--tap); }
main { max-width: var(--measure); margin: 0 auto; padding: var(--space-4) var(--gutter) calc(var(--space-7) + env(safe-area-inset-bottom)); }
h1 { margin: 0; font-size: var(--text-lg); line-height: 1.25; }
h2 { margin: var(--space-7) 0 var(--space-2); font-size: var(--text-xl); line-height: 1.25; }
h3 { margin: var(--space-5) 0 var(--space-2); font-size: var(--text-md); line-height: 1.4; }
p { margin: var(--space-3) 0; }
.meta { color: var(--muted); font: var(--text-sm)/1.45 var(--font-ui); }
ul.meta { padding-left: var(--space-5); }
.sign-in { display: flex; justify-content: center; padding-top: var(--space-5); }

/* One thing to decide per card: its state, what it says, then the decision. */
article, .card-box { margin: var(--space-4) 0; padding: var(--space-4); border: 1px solid var(--line); border-radius: var(--radius); }
article > :first-child, .card-box > :first-child { margin-top: 0; }
article > :last-child, .card-box > :last-child { margin-bottom: 0; }
.card-box h2 { margin: 0 0 var(--space-2); font-size: var(--text-lg); }
.card-box article { margin: 0; padding: var(--space-4) 0; border: 0; border-top: 1px solid var(--line); border-radius: 0; }
article:focus { outline: 2px solid var(--ink); outline-offset: 4px; }
:focus-visible { outline: 2px solid var(--ink); outline-offset: 2px; }
blockquote { margin: var(--space-3) 0; padding: var(--space-1) 0 var(--space-1) var(--space-3); border-left: 3px solid var(--edge); }
.clickable-quote { cursor: pointer; text-decoration: underline; text-decoration-style: dotted; text-underline-offset: 3px; }
pre { margin: var(--space-3) 0; padding: var(--space-3); overflow-x: auto; border: 1px solid var(--line); border-radius: var(--radius); font: var(--text-xs)/1.5 var(--font-code); white-space: pre-wrap; overflow-wrap: anywhere; }
/* A scene is prose to read, not code. */
.scene-viewer > pre { padding: 0; border: 0; border-radius: 0; font: inherit; }
mark { padding: 2px 4px; border-radius: 3px; background: var(--mark); color: inherit; }

.badge { display: inline-block; margin-right: var(--space-2); padding: 2px var(--space-2); border: 1px solid var(--edge); border-radius: 4px; font: var(--text-xs)/1.3 var(--font-ui); vertical-align: middle; }
.state-badge { padding: var(--space-1) var(--space-3); font-size: var(--text-sm); font-weight: 700; }
.state-proposed { border-color: var(--ink); }
.state-accepted { border-color: var(--accept); background: var(--accept-bg); color: var(--accept); }
.state-rejected { border-color: var(--reject); background: var(--reject-bg); color: var(--reject); }
.badge-stale { border-color: var(--reject); background: none; color: var(--reject); }

/* Controls: 16 px text (iOS zooms the page below that) and a 44 px tap target. */
button, select, input, textarea { min-height: var(--tap); max-width: 100%; margin: 0; padding: var(--space-2) var(--space-4); border: 1px solid var(--edge); border-radius: var(--radius); background: transparent; color: inherit; font: var(--text-md)/1.3 var(--font-ui); touch-action: manipulation; }
button { cursor: pointer; transition: background-color .12s, opacity .12s; }
button.accept { border-color: var(--accept); background: var(--accept); color: var(--paper); font-weight: 600; }
button.reject { border-color: var(--reject); color: var(--reject); font-weight: 600; }
button.active, button[aria-pressed=true] { border-color: var(--ink); background: var(--pressed); font-weight: 700; }
button:disabled { opacity: .5; cursor: default; }
input[type=text] { flex: 1 1 14rem; min-width: 0; padding: var(--space-2) var(--space-3); }
input[type=file] { flex: 1 1 14rem; min-width: 0; padding: 0; border: 0; border-radius: 0; }
input[type=file]::file-selector-button { min-height: var(--tap); margin: 0 var(--space-3) 0 0; padding: var(--space-2) var(--space-4); border: 1px solid var(--edge); border-radius: var(--radius); background: transparent; color: inherit; font: var(--text-md)/1.3 var(--font-ui); cursor: pointer; }
summary { min-height: var(--tap); padding: var(--space-3) 0; color: var(--muted); font: var(--text-sm)/1.45 var(--font-ui); cursor: pointer; }
@media (hover: hover) {
  button:not(:disabled):hover, input[type=file]::file-selector-button:hover, .clickable-quote:hover { background: var(--pressed); }
  button.accept:not(:disabled):hover { background: var(--accept); opacity: .85; }
}

.toolbar { display: flex; flex-wrap: wrap; gap: var(--space-3); align-items: center; margin-bottom: var(--space-5); padding-bottom: var(--space-4); border-bottom: 1px solid var(--line); }
.toolbar > select, .toolbar > h2 { flex: 1 1 12rem; min-width: 0; margin: 0; }
.form-row { display: flex; flex-wrap: wrap; gap: var(--space-2) var(--space-3); align-items: center; margin-top: var(--space-3); }
.form-row > label { font: var(--text-sm)/1.45 var(--font-ui); }
.form-row > select { flex: 1 1 12rem; min-width: 0; }
.note-counter { flex-basis: 100%; }
.actions { display: flex; flex-wrap: wrap; gap: var(--space-3); margin-top: var(--space-4); }
/* Accept and reject: far enough apart that one is never hit for the other. */
.decision { gap: var(--space-4); padding-top: var(--space-4); border-top: 1px solid var(--line); }
.scenes-grid { display: flex; flex-wrap: wrap; gap: var(--space-2); margin: var(--space-3) 0; }
.scenes-grid > button { text-align: left; }
.scene-viewer { margin-top: var(--space-4); padding-top: var(--space-4); border-top: 1px solid var(--line); }

/* The diff wraps; a change is marked by its label, its bar and its line, not by colour alone. */
.visual-diff { margin: var(--space-3) 0; padding: var(--space-2) 0; border: 1px solid var(--line); border-radius: var(--radius); white-space: pre-wrap; overflow-wrap: anywhere; }
.visual-diff > div { padding: var(--space-1) var(--space-3); }
.visual-diff > .diff-removed, .visual-diff > .diff-added { margin: var(--space-1) 0; padding-left: var(--space-2); border-left: 4px solid; }
.diff-removed { border-color: var(--reject); background: var(--reject-bg); }
.diff-added { border-color: var(--accept); background: var(--accept-bg); }
.diff-label { display: block; font: 700 var(--text-xs)/1.5 var(--font-ui); }
.diff-removed > .diff-label { color: var(--reject); }
.diff-added > .diff-label { color: var(--accept); }
del { text-decoration-line: line-through; text-decoration-color: var(--reject); text-decoration-thickness: 1px; }
ins { text-decoration-line: underline; text-decoration-color: var(--accept); text-decoration-thickness: 2px; text-underline-offset: 3px; }

/* The newest error follows the reader: it is added at the top of a long page. */
[role=alert] { margin: 0 0 var(--space-3); padding: var(--space-3) var(--space-4); border: 1px solid var(--reject); border-left-width: 4px; border-radius: var(--radius); background: var(--reject-bg); font: var(--text-sm)/1.45 var(--font-ui); }
main > [role=alert]:first-child { position: sticky; top: max(var(--space-2), env(safe-area-inset-top)); z-index: 3; }
[role=status] { color: var(--accept); font-weight: 600; }
/* The refresh notice floats, so showing or hiding it never moves the text being read. */
.notice { position: fixed; z-index: 2; top: max(var(--space-2), env(safe-area-inset-top)); left: 0; right: 0; width: min(100% - 2 * var(--gutter), var(--measure) - 2 * var(--space-4)); margin: 0 auto; padding: var(--space-3) var(--space-4); border: 1px solid var(--edge); border-left: 4px solid var(--accept); border-radius: var(--radius); background: var(--paper); box-shadow: 0 2px 10px rgb(0 0 0 / .2); color: var(--ink); font: var(--text-sm)/1.45 var(--font-ui); }
/* Kept rendered while empty: a live region must exist before its text arrives to be announced. */
.notice[hidden] { display: block; width: 1px; height: 1px; padding: 0; border: 0; overflow: hidden; clip-path: inset(50%); box-shadow: none; }
/* With an error showing, the notice goes back into the page: two floating boxes would cover each other or a decision. */
main:has(> [role=alert]) .notice:not([hidden]) { position: static; width: auto; margin: 0 0 var(--space-4); box-shadow: none; }

/* Phone: one column, full-width controls, decision under the thumb. */
@media (max-width: 40em) {
  h2 { margin-top: var(--space-6); font-size: var(--text-lg); }
  article, .card-box { --peek: 120px; padding: var(--space-3); }
  .card-box article { padding: var(--space-4) 0; }
  .toolbar > button, .actions > button { flex: 1 1 auto; }
  .form-row > label, .form-row > select, .form-row > input { flex: 1 1 100%; }
  /* The bar stays inside its card. Its top margin is room it must leave above itself,
     so it only shows once the card it decides is on screen; the element before it
     takes the same room back, and at rest nothing moves. */
  .decision { position: sticky; bottom: 0; z-index: 1; flex-wrap: nowrap; margin: calc(var(--peek) + var(--space-4)) calc(-1 * var(--space-3)) calc(-1 * var(--space-3)); padding: var(--space-3) var(--space-3) max(var(--space-3), env(safe-area-inset-bottom)); border-radius: 0 0 var(--radius) var(--radius); background: var(--paper); }
  article > :has(+ .decision) { margin-bottom: calc(-1 * var(--peek)); }
  .decision > button { flex: 1 1 0; min-width: 0; padding-left: var(--space-2); padding-right: var(--space-2); }
  .decision > .accept { flex-grow: 1.4; }
  .card-box .decision { margin: calc(var(--peek) + var(--space-4)) 0 calc(-1 * var(--space-4)); padding-left: 0; padding-right: 0; border-radius: 0; }
}
/* Tablet and desktop: the same column, with more air. */
@media (min-width: 48em) {
  main { padding-top: var(--space-6); }
  article, .card-box { padding: var(--space-5); }
  .card-box article { padding: var(--space-5) 0; }
}
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after { transition: none !important; animation: none !important; scroll-behavior: auto !important; }
}
`;

export const REVIEW_JS = String.raw`
'use strict';

const app = document.getElementById('app');
const decidedProposals = new Set();
const decidedClaims = new Set();
const MAX_NOTE = 2000;
let nextNoteCounter = 0;
// Background refresh: the page asks for the queue again every few seconds while it
// is visible, and the server answers 304 when nothing changed.
const REFRESH_MS = 5000;
const REFRESH_MAX_MS = 60000;
let view = null;
let openScene = null;
let renderSeq = 0;
let actionsRunning = 0;
let refreshTimer = null;
let refreshDelay = REFRESH_MS;
let refreshing = false;
const STATE_LABELS = { proposed: 'Pendiente', accepted: 'Aceptada', rejected: 'Rechazada' };
const NEWS_NOTICE = 'Hay novedades en este libro. Se mostrarán cuando termines lo que tienes a medias: una nota, un formulario o un diálogo abierto.';

// A live region is announced when its text changes while it is rendered, so the
// notice stays in the page, empty, and receives its text when there is news.
function setNotice(notice, shown) {
  if (notice.hidden === !shown) return;
  notice.hidden = !shown;
  notice.textContent = shown ? NEWS_NOTICE : '';
}

// Smooth scrolling is motion: people who asked for less get a plain jump.
function scrollBehavior() {
  const reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  return reduce ? 'auto' : 'smooth';
}

function stateBadge(state, stale) {
  return el('span', stale ? 'No aplicable: la escena ha cambiado' : STATE_LABELS[state], 'badge state-badge state-' + state + (stale ? ' badge-stale' : ''));
}

async function decideCard(path, decision, remembered, key, card, reload) {
  await api(path, { decision });
  remembered.add(key);
  await reload();
  const updated = document.getElementById(card.id);
  if (updated) {
    updated.focus({ preventScroll: true });
    updated.scrollIntoView({ block: 'nearest' });
  }
}

function el(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}

function showError(message) {
  const alert = el('p', message);
  alert.setAttribute('role', 'alert');
  app.prepend(alert);
}

async function api(path, body) {
  const token = await window.Clerk.session.getToken();
  const res = await fetch('/review/api' + path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      authorization: 'Bearer ' + token,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'No se pudo completar la operación');
  return data;
}

// Reads state together with its validator; a known validator turns an unchanged
// answer into a 304 without a body.
async function apiState(path, known) {
  const token = await window.Clerk.session.getToken();
  const headers = { authorization: 'Bearer ' + token };
  if (known) headers['if-none-match'] = known;
  const res = await fetch('/review/api' + path, { method: 'GET', headers });
  if (res.status === 304) return { changed: false };
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'No se pudo completar la operación');
  return { changed: true, data, tag: res.headers ? res.headers.get('etag') : null };
}

async function apiUpload(path, file, mapping, dryRun) {
  const token = await window.Clerk.session.getToken();
  const headers = {
    authorization: 'Bearer ' + token,
    'content-type': 'application/zip',
  };
  if (mapping) {
    headers['x-notion-mapping'] = encodeURIComponent(JSON.stringify(mapping));
  }
  if (dryRun) {
    headers['x-dry-run'] = 'true';
  }
  const res = await fetch('/review/api' + path, {
    method: 'POST',
    headers,
    body: file,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'No se pudo completar la operación');
  return data;
}

function button(label, className, run) {
  const node = el('button', label, className);
  node.type = 'button';
  node.addEventListener('click', async () => {
    node.disabled = true;
    actionsRunning++;
    try {
      await run();
    } catch (error) {
      showError(error.message);
    } finally {
      // Not every action re-renders the page: a button that stays must work again.
      node.disabled = false;
      actionsRunning--;
    }
  });
  return node;
}

function quote(text, detail) {
  const box = el('div');
  box.append(el('blockquote', text), el('p', detail, 'meta'));
  return box;
}

function claimCard(book, claim, reload) {
  const card = el('article');
  card.id = 'claim-' + book + '-' + claim.claim_id;
  card.tabIndex = -1;
  card.append(stateBadge(claim.editorial_status), el('p', claim.statement));
  const reason = outsideCanonReason(claim);
  if (reason) card.append(el('p', 'Fuera del Canon: ' + reason, 'meta'));
  card.append(quote(claim.anchor.quote, claim.source_file + ' · ' + claim.epistemic_kind + ' · evidencia: ' + claim.evidence_status + ' · propuesto por: ' + claim.extractor));
  if (claim.uncertainty) card.append(el('p', 'Incertidumbre: ' + claim.uncertainty, 'meta'));
  if (claim.editorial_status === 'proposed') {
    const actions = el('div', undefined, 'actions decision');
    const decide = (decision) => () => decideCard('/books/' + book + '/claims/' + claim.claim_id, decision, decidedClaims, book + '/' + claim.claim_id, card, reload);
    if (claim.evidence_status === 'valid') actions.append(button('Aceptar', 'accept', decide('accept')));
    actions.append(button('Rechazar', 'reject', decide('reject')));
    card.append(actions);
  }
  return card;
}

const VERDICTS = { confirmed: 'Es un error real', deliberate_mystery: 'Misterio deliberado', false_positive: 'Falso positivo', useful: 'Me ayuda', noise: 'Ruido' };

const FINDING_KINDS = {
  fact: 'Hecho del texto',
  interpretation: 'Interpretación',
  alternative: 'Idea alternativa',
};

function narrativeFindingCard(book, finding, reload, openQuote) {
  const card = el('article');
  const kindBadge = el('span', FINDING_KINDS[finding.kind] || finding.kind, 'badge');
  const statement = el('p');
  statement.append(kindBadge, document.createTextNode(finding.statement));
  card.append(statement);

  if (finding.characters && finding.characters.length) {
    card.append(el('p', 'Personajes: ' + finding.characters.join(', '), 'meta'));
  }
  card.append(el('p', 'Propuesto por: ' + finding.author, 'meta'));

  for (const ev of finding.evidence) {
    const evBox = el('div');
    const quoteEl = el('blockquote', ev.quote, 'clickable-quote');
    quoteEl.title = 'Haz clic para ver y resaltar esta cita en la escena';
    if (openQuote) {
      const open = () => openQuote(ev.file, ev.quote, ev.anchor, ev.status);
      quoteEl.addEventListener('click', open);
      // The same action from the keyboard.
      quoteEl.tabIndex = 0;
      quoteEl.addEventListener('keydown', (event) => {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        event.preventDefault();
        open();
      });
    }
    const statusText = ev.status === 'valid' ? 'válida' : (ev.status === 'stale' ? 'desactualizada' : (ev.status === 'orphaned' ? 'la cita ya no está en el texto' : ev.status));
    let detail = ev.file + ' · evidencia: ' + statusText;
    if (ev.status === 'stale') {
      detail += ' (el texto alrededor de la cita cambió en la escena)';
    }
    evBox.append(quoteEl, el('p', detail, 'meta' + (ev.status === 'stale' || ev.status === 'orphaned' ? ' badge-stale' : '')));
    card.append(evBox);
  }

  if (finding.evidence_status === 'orphaned' || finding.evidence.some(ev => ev.status === 'orphaned')) {
    card.append(el('p', 'Aviso: una cita de este hallazgo ya no aparece en la escena.', 'meta badge-stale'));
  } else if (finding.evidence_status === 'stale' || finding.evidence.some(ev => ev.status === 'stale')) {
    card.append(el('p', 'Aviso: La evidencia general está desactualizada; el texto de la escena ha cambiado.', 'meta badge-stale'));
  }

  if (finding.verdict) {
    const vText = finding.verdict.verdict === 'useful' ? 'Me ayuda' : (finding.verdict.verdict === 'noise' ? 'Ruido' : (VERDICTS[finding.verdict.verdict] || finding.verdict.verdict));
    const when = new Date(finding.verdict.at).toLocaleString('es');
    let summary = 'Valoración actual: ' + vText + ' · por ' + finding.verdict.by + ' el ' + when;
    if (finding.verdict.note) summary += ' · Nota: "' + finding.verdict.note + '"';
    card.append(el('p', summary, 'meta'));
  }

  const ratingRow = el('div', undefined, 'form-row actions');
  const noteInput = el('input');
  noteInput.type = 'text';
  noteInput.placeholder = 'Nota opcional sobre la valoración…';
  noteInput.setAttribute('aria-label', 'Nota opcional sobre la valoración');
  if (finding.verdict && finding.verdict.note) {
    // The saved note is the field's baseline: only text typed after it is unsaved.
    noteInput.defaultValue = finding.verdict.note;
    noteInput.value = finding.verdict.note;
  }
  const counter = el('span', undefined, 'meta note-counter');
  counter.id = 'note-count-' + book + '-' + finding.finding_id + '-' + nextNoteCounter++;
  noteInput.setAttribute('aria-describedby', counter.id);
  const updateCounter = () => {
    counter.textContent = noteInput.value.length + ' / ' + MAX_NOTE + ' caracteres';
    noteInput.setAttribute('aria-invalid', String(noteInput.value.length > MAX_NOTE));
  };
  noteInput.addEventListener('input', updateCounter);
  updateCounter();
  const rate = (verdict) => async () => {
    if (noteInput.value.length > MAX_NOTE) throw new Error('La nota supera el límite de ' + MAX_NOTE + ' caracteres.');
    const note = noteInput.value.trim() || undefined;
    await api('/books/' + book + '/findings/' + finding.finding_id, { verdict, note });
    await reload();
  };
  const usefulBtn = button('Me ayuda', finding.verdict?.verdict === 'useful' ? 'active' : '', rate('useful'));
  const noiseBtn = button('Ruido', finding.verdict?.verdict === 'noise' ? 'active' : '', rate('noise'));
  usefulBtn.setAttribute('aria-pressed', String(finding.verdict?.verdict === 'useful'));
  noiseBtn.setAttribute('aria-pressed', String(finding.verdict?.verdict === 'noise'));
  ratingRow.append(noteInput, counter, usefulBtn, noiseBtn);
  card.append(ratingRow);

  return card;
}

function findingsSection(book, findings, reload, openQuote) {
  const box = el('section', undefined, 'card-box');
  const headerRow = el('div', undefined, 'toolbar');
  headerRow.append(el('h2', 'Hallazgos de la trama'));
  const exportBtn = button('Descargar evaluación (JSON)', '', async () => {
    const data = await api('/books/' + book + '/export');
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'findings-' + book + '.json';
    a.click();
    URL.revokeObjectURL(url);
  });
  headerRow.append(exportBtn);
  box.append(headerRow);

  if (!findings || !findings.length) {
    box.append(el('p', 'Sin hallazgos narrativos propuestos para este libro.', 'meta'));
    return box;
  }

  const QUESTION_LABELS = {
    motivation: 'Motivación: ¿Qué quiere cada personaje y por qué actúa de esa manera?',
    consequences: 'Consecuencias: ¿Qué consecuencias tienen sus decisiones y qué contradicciones podrían existir?',
    knowledge: 'Conocimiento: ¿Qué sabe cada personaje, qué sabe el lector y qué información falta para entender la historia?',
  };
  const QUESTION_ORDER = ['motivation', 'consequences', 'knowledge'];

  for (const q of QUESTION_ORDER) {
    const grouped = findings.filter((f) => f.question === q);
    if (grouped.length) {
      box.append(el('h3', QUESTION_LABELS[q] || q));
      for (const f of grouped) {
        box.append(narrativeFindingCard(book, f, reload, openQuote));
      }
    }
  }

  const others = findings.filter((f) => !QUESTION_ORDER.includes(f.question));
  if (others.length) {
    box.append(el('h3', 'Otros hallazgos'));
    for (const f of others) {
      box.append(narrativeFindingCard(book, f, reload, openQuote));
    }
  }

  return box;
}

function findingCard(book, finding, reload) {
  const card = el('article');
  card.append(el('p', finding.explanation));
  card.append(el('p', 'Posible problema, no un veredicto · ' + finding.classification, 'meta'));
  for (const c of finding.citations) card.append(quote(c.quote, c.source_file + ' · momento de la historia: ' + (c.story_time ?? 'desconocido') + ' · evidencia: ' + c.evidence_status));
  const others = el('ul', undefined, 'meta');
  for (const alternative of finding.alternatives) others.append(el('li', alternative));
  card.append(others);
  if (finding.verdict) card.append(el('p', 'Decisión: ' + (VERDICTS[finding.verdict.verdict] || finding.verdict.verdict), 'meta'));
  const actions = el('div', undefined, 'actions');
  for (const [verdict, label] of Object.entries(VERDICTS)) {
    actions.append(button(label, '', () => api('/books/' + book + '/findings/' + finding.finding_id, { verdict }).then(reload)));
  }
  card.append(actions);
  return card;
}

function visualDiff(diff) {
  const box = el('div', undefined, 'visual-diff');
  box.setAttribute('aria-label', 'Cambios respecto a la versión base de la propuesta');
  let inHunk = false;
  for (const line of diff.split('\n')) {
    if (line.startsWith('@@')) { inHunk = true; continue; }
    if (!inHunk) continue;
    if (line.startsWith('-') || line.startsWith('+')) {
      const removed = line.startsWith('-');
      const row = el('div', undefined, removed ? 'diff-removed' : 'diff-added');
      row.append(el('span', removed ? '− Eliminado:' : '+ Añadido:', 'diff-label'), el(removed ? 'del' : 'ins', line.slice(1)));
      box.append(row);
    } else if (line.startsWith(' ')) {
      box.append(el('div', line.slice(1)));
    }
  }
  const plain = el('details');
  plain.append(el('summary', 'Ver diff unificado (texto)'), el('pre', diff));
  const result = el('div');
  result.append(box, plain);
  return result;
}

function outsideCanonReason(claim) {
  if (claim.editorial_status === 'proposed') return 'pendiente de revisión humana';
  if (claim.editorial_status === 'rejected') return 'rechazada en la revisión humana';
  const reasons = [];
  if (claim.epistemic_kind !== 'narrated_fact') reasons.push('no es un hecho narrado (rumor, creencia u otra interpretación)');
  if (claim.evidence_status !== 'valid') reasons.push('evidencia ' + (claim.evidence_status === 'stale' ? 'desactualizada' : 'no válida: la cita ya no está en el texto'));
  return reasons.join('; ');
}

function proposalCard(book, { proposal, diff, applicable }, reload) {
  const card = el('article');
  card.id = 'proposal-' + book + '-' + proposal.proposal_id;
  card.tabIndex = -1;
  card.append(stateBadge(proposal.status, proposal.status === 'proposed' && !applicable));
  card.append(el('p', proposal.rationale), visualDiff(diff));
  if (proposal.status !== 'proposed') {
    if (proposal.result_commit) card.append(el('p', 'Cambio aprobado del manuscrito · versión ' + proposal.result_commit.slice(0, 10), 'meta'));
    return card;
  }
  const actions = el('div', undefined, 'actions decision');
  const decide = (decision) => () => decideCard('/books/' + book + '/proposals/' + proposal.proposal_id, decision, decidedProposals, book + '/' + proposal.proposal_id, card, reload);
  if (applicable) actions.append(button('Aceptar cambio', 'accept', decide('accept')));
  else card.append(el('p', 'La escena ha cambiado desde esta propuesta: ya no se puede aplicar.', 'meta'));
  actions.append(button('Rechazar', 'reject', decide('reject')));
  card.append(actions);
  return card;
}

function section(title, cards, empty, explanation) {
  const box = el('section');
  box.append(el('h2', title));
  if (explanation) box.append(el('p', explanation, 'meta'));
  if (!cards.length) box.append(el('p', empty, 'meta'));
  for (const card of cards) {
    if (card.id) card.id = encodeURIComponent(title) + '-' + card.id;
  }
  box.append(...cards);
  return box;
}

function createBookSection(onCreated) {
  const box = el('section', undefined, 'card-box');
  box.append(el('h2', 'Crear un nuevo libro'));
  const row = el('div', undefined, 'form-row');
  const input = el('input');
  input.type = 'text';
  input.placeholder = 'Título del libro';
  input.setAttribute('aria-label', 'Título del libro');
  const submit = button('Crear libro', '', async () => {
    const title = input.value.trim();
    if (!title) throw new Error('Escribe un título para el libro');
    const created = await api('/books', { title });
    input.value = '';
    await onCreated(created.book_id);
  });
  row.append(input, submit);
  box.append(row);
  return box;
}

function importSection(book, onImported) {
  const box = el('section', undefined, 'card-box');
  box.append(el('h2', 'Importar escenas Markdown'));
  box.append(el('p', 'Selecciona uno o más archivos .md (máximo 2 MB por archivo) para añadirlos al libro.', 'meta'));
  const row = el('div', undefined, 'form-row');
  const input = el('input');
  input.type = 'file';
  input.multiple = true;
  input.accept = '.md';
  input.setAttribute('aria-label', 'Archivos Markdown');
  const status = el('p', undefined, 'meta');
  const submit = button('Importar Markdown', '', async () => {
    status.textContent = '';
    if (!input.files || input.files.length === 0) {
      throw new Error('Selecciona al menos un archivo Markdown (.md)');
    }
    const files = [];
    for (const f of input.files) {
      if (!f.name.endsWith('.md')) throw new Error('Solo se admiten archivos Markdown (.md): ' + f.name);
      if (f.size > 2 * 1024 * 1024) throw new Error('El archivo supera el límite de 2 MB: ' + f.name);
      files.push({ name: f.name, content: await f.text() });
    }
    const result = await api('/books/' + book + '/import', { files });
    status.textContent = 'Importadas: ' + (result.imported.join(', ') || 'ninguna') + (result.unchanged.length ? ' · Sin cambios: ' + result.unchanged.join(', ') : '');
    status.setAttribute('role', 'status');
    input.value = '';
    await onImported();
  });
  row.append(input, submit);
  box.append(row, status);
  return box;
}

function notionImportSection(book, onImported) {
  const box = el('section', undefined, 'card-box');
  box.append(el('h2', 'Importar desde Notion'));
  box.append(el('p', 'Sube una exportación de Notion en formato .zip (Markdown y CSV, hasta 50 MB) para inspeccionar y trasladar tus capítulos a RE;write sin usar la terminal.', 'meta'));

  const fileRow = el('div', undefined, 'form-row');
  const fileInput = el('input');
  fileInput.type = 'file';
  fileInput.accept = '.zip';
  fileInput.setAttribute('aria-label', 'Exportación de Notion (.zip)');

  const inspectBtn = button('Inspeccionar exportación', '', async () => {
    statusMsg.textContent = '';
    resultBox.replaceChildren();
    mappingBox.replaceChildren();
    mappingBox.style.display = 'none';
    previewBox.replaceChildren();

    if (!fileInput.files || fileInput.files.length === 0) {
      throw new Error('Selecciona un archivo .zip exportado de Notion');
    }
    const file = fileInput.files[0];
    if (file.size > 50 * 1024 * 1024) {
      throw new Error('El archivo supera el límite de 50 MB');
    }

    statusMsg.textContent = 'Inspeccionando archivo…';
    const report = await apiUpload('/books/' + book + '/notion-inspect', file);
    statusMsg.textContent = '';

    renderInspection(file, report);
  });

  fileRow.append(fileInput, inspectBtn);

  const statusMsg = el('p', undefined, 'meta');
  const inspectSummary = el('div');
  const mappingBox = el('div', undefined, 'card-box');
  mappingBox.style.display = 'none';
  const previewBox = el('div');
  const resultBox = el('div');

  box.append(fileRow, statusMsg, inspectSummary, mappingBox, previewBox, resultBox);

  function renderInspection(file, report) {
    inspectSummary.replaceChildren();
    mappingBox.replaceChildren();
    previewBox.replaceChildren();
    resultBox.replaceChildren();

    if (!report.databases || report.databases.length === 0) {
      inspectSummary.append(el('p', 'No se encontraron bases de datos (CSV) en la exportación.', 'meta'));
      return;
    }

    inspectSummary.append(el('h3', 'Estructura encontrada en la exportación'));
    const dbList = el('ul', undefined, 'meta');
    for (const db of report.databases) {
      const li = el('li');
      li.textContent = db.name + ' (' + db.rowCount + (db.rowCount === 1 ? ' fila' : ' filas') + ') · Columnas: ' + (db.columns.join(', ') || 'ninguna');
      dbList.append(li);
    }
    inspectSummary.append(dbList);
    inspectSummary.append(el('p', 'Páginas encontradas: ' + (report.pages ? report.pages.length : 0), 'meta'));

    renderMappingForm(file, report);
  }

  function renderMappingForm(file, report) {
    mappingBox.style.display = 'block';
    mappingBox.append(el('h3', 'Configurar correspondencia (Mapping)'));

    // Database picker
    const dbRow = el('div', undefined, 'form-row');
    dbRow.append(el('label', 'Base de datos de capítulos:'));
    const dbSelect = el('select');
    dbSelect.setAttribute('aria-label', 'Base de datos de capítulos');

    let defaultDbIndex = 0;
    report.databases.forEach((db, idx) => {
      const opt = el('option', db.name);
      opt.value = db.name;
      const low = db.name.toLowerCase();
      if (low.includes('_all.csv') || low.includes('capítulo') || low.includes('capitulo')) {
        defaultDbIndex = idx;
      }
      dbSelect.append(opt);
    });
    dbSelect.selectedIndex = defaultDbIndex;
    dbRow.append(dbSelect);
    mappingBox.append(dbRow);

    const colsContainer = el('div');
    mappingBox.append(colsContainer);

    function updateColumnSelects() {
      colsContainer.replaceChildren();
      const selectedDbName = dbSelect.value;
      const currentDb = report.databases.find((d) => d.name === selectedDbName) || report.databases[0];
      const cols = currentDb ? currentDb.columns : [];

      // Title column
      const titleRow = el('div', undefined, 'form-row');
      titleRow.append(el('label', 'Columna de título:'));
      const titleSelect = el('select');
      titleSelect.setAttribute('aria-label', 'Columna de título');
      let defaultTitleIdx = 0;
      cols.forEach((col, idx) => {
        const opt = el('option', col);
        opt.value = col;
        const low = col.toLowerCase();
        if (low === 'título' || low === 'titulo' || low === 'title' || low === 'nombre' || low === 'capítulo') {
          defaultTitleIdx = idx;
        }
        titleSelect.append(opt);
      });
      if (cols.length > 0) titleSelect.selectedIndex = defaultTitleIdx;
      titleRow.append(titleSelect);
      colsContainer.append(titleRow);

      // Order column
      const orderRow = el('div', undefined, 'form-row');
      orderRow.append(el('label', 'Columna de orden:'));
      const orderSelect = el('select');
      orderSelect.setAttribute('aria-label', 'Columna de orden');
      const tableOrderOpt = el('option', 'orden de la tabla');
      tableOrderOpt.value = '';
      orderSelect.append(tableOrderOpt);
      let defaultOrderIdx = 0;
      cols.forEach((col, idx) => {
        const opt = el('option', col);
        opt.value = col;
        const low = col.toLowerCase();
        if (low === 'orden' || low === 'order' || low === 'número' || low === 'numero') {
          defaultOrderIdx = idx + 1;
        }
        orderSelect.append(opt);
      });
      orderSelect.selectedIndex = defaultOrderIdx;
      orderRow.append(orderSelect);
      colsContainer.append(orderRow);

      // Filter column + value
      const filterRow = el('div', undefined, 'form-row');
      filterRow.append(el('label', 'Filtrar por columna (opcional):'));
      const filterColSelect = el('select');
      filterColSelect.setAttribute('aria-label', 'Columna de filtro');
      const noFilterOpt = el('option', '(sin filtro)');
      noFilterOpt.value = '';
      filterColSelect.append(noFilterOpt);
      cols.forEach((col) => {
        const opt = el('option', col);
        opt.value = col;
        filterColSelect.append(opt);
      });
      filterRow.append(filterColSelect);

      const filterValInput = el('input');
      filterValInput.type = 'text';
      filterValInput.placeholder = 'Valor del filtro (ej. nombre del libro)';
      filterValInput.setAttribute('aria-label', 'Valor del filtro');
      filterRow.append(filterValInput);
      colsContainer.append(filterRow);

      // Buttons row
      const btnRow = el('div', undefined, 'form-row actions');

      function buildMapping() {
        const mapping = {
          database: dbSelect.value,
          titleColumn: titleSelect.value,
        };
        if (orderSelect.value) {
          mapping.orderColumn = orderSelect.value;
        }
        if (filterColSelect.value && filterValInput.value.trim()) {
          mapping.filter = {
            column: filterColSelect.value,
            value: filterValInput.value.trim(),
          };
        }
        return mapping;
      }

      const previewBtn = button('Vista previa', '', async () => {
        previewBox.replaceChildren(el('p', 'Generando vista previa…', 'meta'));
        resultBox.replaceChildren();
        const mapping = buildMapping();
        const previewData = await apiUpload('/books/' + book + '/notion-import', file, mapping, true);

        previewBox.replaceChildren();
        previewBox.append(el('h3', 'Vista previa (' + (previewData.chapters ? previewData.chapters.length : 0) + ' capítulos)'));
        if (!previewData.chapters || previewData.chapters.length === 0) {
          previewBox.append(el('p', 'Ningún capítulo coincide con la configuración seleccionada.', 'meta'));
          return;
        }
        const ul = el('ul', undefined, 'meta');
        for (const ch of previewData.chapters) {
          const li = el('li');
          const pad = String(ch.order).padStart(3, '0');
          if (ch.status === 'missing_page') {
            li.textContent = '[' + pad + '] ' + ch.title + ' (' + ch.file + ') — Falta el archivo de página [PÁGINA NO ENCONTRADA]';
            li.className = 'badge-stale';
          } else {
            li.textContent = '[' + pad + '] ' + ch.title + ' (' + ch.file + ') — ' + ch.size.toLocaleString('es') + ' bytes';
          }
          ul.append(li);
        }
        previewBox.append(ul);
      });

      const importBtn = button('Importar', 'accept', async () => {
        resultBox.replaceChildren(el('p', 'Importando capítulos…', 'meta'));
        previewBox.replaceChildren();
        const mapping = buildMapping();
        const result = await apiUpload('/books/' + book + '/notion-import', file, mapping, false);

        resultBox.replaceChildren();
        resultBox.append(el('h3', 'Resultado de la importación'));

        const importedNames = result.imported.map((i) => i.file).join(', ') || 'ninguno';
        const unchangedNames = result.unchanged.map((u) => u.file).join(', ') || 'ninguno';
        const refusedDetails = result.refused.map((r) => r.file + ' (' + r.reason + ')').join(', ') || 'ninguno';

        resultBox.append(el('p', 'Importados: ' + importedNames, result.imported.length ? 'badge' : 'meta'));
        resultBox.append(el('p', 'Sin cambios: ' + unchangedNames, 'meta'));
        if (result.refused.length > 0) {
          resultBox.append(el('p', 'Rechazados: ' + refusedDetails, 'badge-stale'));
        }

        await onImported();
      });

      btnRow.append(previewBtn, importBtn);
      colsContainer.append(btnRow);
    }

    dbSelect.addEventListener('change', updateColumnSelects);
    updateColumnSelects();
  }

  return box;
}

function scenesSection(book, scenes, reloadBook, registerOpenQuote) {
  const box = el('section', undefined, 'card-box');
  box.append(el('h2', 'Navegar escenas'));
  if (!scenes || !scenes.length) {
    box.append(el('p', 'Este libro aún no tiene escenas. Importa archivos Markdown arriba para empezar.', 'meta'));
    return box;
  }
  const grid = el('div', undefined, 'scenes-grid');
  const viewer = el('div', undefined, 'scene-viewer');
  viewer.style.display = 'none';

  let activeBtn = null;
  // quiet: a background refresh reopens the scene without moving the reader.
  const loadScene = async (sceneFile, highlight, quiet) => {
    const canonical = sceneFile.startsWith('scenes/') ? sceneFile : 'scenes/' + sceneFile;
    openScene = { file: canonical, highlight };
    if (activeBtn) {
      activeBtn.classList.remove('active');
      activeBtn.setAttribute('aria-current', 'false');
    }
    for (const child of grid.children) {
      if (child.textContent === canonical || child.textContent === sceneFile) {
        child.classList.add('active');
        child.setAttribute('aria-current', 'true');
        activeBtn = child;
        break;
      }
    }
    viewer.style.display = 'block';
    viewer.replaceChildren(el('p', 'Cargando escena…', 'meta'));
    try {
      const data = await api('/books/' + book + '/scenes/' + encodeURIComponent(canonical));
      viewer.replaceChildren();
      viewer.append(el('h3', data.file));

      if (highlight && (highlight.status === 'stale' || highlight.status === 'orphaned')) {
        const warning = highlight.status === 'orphaned'
          ? 'Aviso: la cita ya no está en el texto de la escena.'
          : 'Aviso: La evidencia está desactualizada. El texto alrededor de la cita cambió en la escena.';
        viewer.append(el('p', warning, 'meta badge-stale'));
      }

      const pre = el('pre');
      if (highlight && highlight.quote) {
        let start = -1;
        const q = highlight.quote;
        if (highlight.anchor && typeof highlight.anchor.start === 'number') {
          if (data.text.slice(highlight.anchor.start, highlight.anchor.start + q.length) === q) {
            start = highlight.anchor.start;
          }
        }
        if (start === -1) {
          start = data.text.indexOf(q);
        }
        if (start !== -1) {
          const before = data.text.slice(0, start);
          const matched = data.text.slice(start, start + q.length);
          const after = data.text.slice(start + q.length);
          const mark = el('mark', matched);
          pre.append(document.createTextNode(before), mark, document.createTextNode(after));
          if (!quiet) setTimeout(() => mark.scrollIntoView({ block: 'center', behavior: scrollBehavior() }), 50);
        } else {
          pre.textContent = data.text;
        }
      } else {
        pre.textContent = data.text;
      }
      viewer.append(pre);

      const citingBox = el('div');
      citingBox.append(el('h3', 'Hallazgos que citan esta escena'));
      if (data.findings && data.findings.length > 0) {
        const reloadScene = async () => {
          await reloadBook(canonical, highlight);
        };
        for (const f of data.findings) {
          citingBox.append(narrativeFindingCard(book, f, reloadScene, (fFile, fQuote, fAnchor, fStatus) => loadScene(fFile, { quote: fQuote, anchor: fAnchor, status: fStatus })));
        }
      } else {
        citingBox.append(el('p', 'Ningún hallazgo cita esta escena.', 'meta'));
      }
      viewer.append(citingBox);

      const propBox = el('div');
      propBox.append(el('h3', 'Propuestas para esta escena'));
      if (data.proposals && data.proposals.length > 0) {
        const reloadScene = async () => {
          await reloadBook(canonical, highlight);
        };
        for (const p of data.proposals) {
          propBox.append(proposalCard(book, p, reloadScene));
        }
      } else {
        propBox.append(el('p', 'Sin cambios pendientes para esta escena.', 'meta'));
      }
      viewer.append(propBox);
      if (!quiet) viewer.scrollIntoView({ behavior: scrollBehavior() });
    } catch (error) {
      viewer.replaceChildren(el('p', error.message, 'meta'));
    }
  };

  if (registerOpenQuote) {
    registerOpenQuote((file, quote, anchor, status, quiet) => {
      return loadScene(file, { quote, anchor, status }, quiet);
    });
  }

  for (const scene of scenes) {
    const btn = button(scene, '', () => loadScene(scene, null));
    grid.append(btn);
  }
  box.append(grid, viewer);
  return box;
}

// Everything below the toolbar for one book, built without touching the page.
function bookSections(currentBook, data) {
  const reload = (scene, highlight) => renderApp(currentBook, scene, highlight);
  const pending = (c) => c.editorial_status === 'proposed';

  let openQuoteHandler = null;
  const scenesBox = scenesSection(currentBook, data.scenes || [], reload, (fn) => { openQuoteHandler = fn; });
  const findingsBox = findingsSection(currentBook, data.finding_views || [], reload, (file, quote, anchor, status) => {
    if (openQuoteHandler) openQuoteHandler(file, quote, anchor, status);
  });

  const nodes = [
    importSection(currentBook, reload),
    notionImportSection(currentBook, reload),
    scenesBox,
    findingsBox,
    section('Cambios propuestos', data.proposals.filter((p) => p.proposal.status === 'proposed' || decidedProposals.has(currentBook + '/' + p.proposal.proposal_id)).map((p) => proposalCard(currentBook, p, reload)), 'Ningún cambio pendiente.', 'Las decisiones de esta sesión permanecen aquí para confirmar su estado.'),
    section('Posibles problemas', data.findings.map((f) => findingCard(currentBook, f, reload)), 'Sin hallazgos, lo que no demuestra que no haya problemas.'),
    section('Afirmaciones por revisar', data.claims.filter((c) => pending(c) || decidedClaims.has(currentBook + '/' + c.claim_id)).map((c) => claimCard(currentBook, c, reload)), 'Ninguna pendiente.', 'Las decisiones de esta sesión permanecen aquí para confirmar su estado.'),
    section('Canon', data.canon.map((c) => claimCard(currentBook, c, reload)), 'El canon está vacío.', 'Solo hechos narrados aceptados por una persona y con evidencia válida. Aceptar un cambio de texto no aprueba sus afirmaciones.'),
    section('Afirmaciones fuera del Canon', data.claims.filter((c) => c.editorial_status === 'accepted' && !data.canon.some((canonical) => canonical.claim_id === c.claim_id)).map((c) => claimCard(currentBook, c, reload)), 'Ninguna afirmación aceptada fuera del Canon.', 'Una afirmación aceptada puede seguir fuera del Canon por su tipo o por su evidencia.'),
    section('Afirmaciones rechazadas', data.claims.filter((c) => c.editorial_status === 'rejected').map((c) => claimCard(currentBook, c, reload)), 'Ninguna afirmación rechazada.', 'Las afirmaciones rechazadas no forman parte del Canon.'),
    section('Historial de cambios del manuscrito', data.proposals.filter((p) => p.proposal.status !== 'proposed').map((p) => proposalCard(currentBook, p, reload)), 'Sin decisiones todavía.', 'Aceptar una propuesta cambia el manuscrito, pero no convierte sus afirmaciones en Canon. Las propuestas rechazadas no cambian el texto.'),
  ];
  return { nodes, openQuote: (...args) => openQuoteHandler ? openQuoteHandler(...args) : undefined };
}

async function renderApp(selectedBookId, selectedScene, highlight) {
  const seq = ++renderSeq;
  // Nothing refreshes in the background until this render has settled.
  view = null;
  openScene = null;
  const { books } = await api('/books');
  app.replaceChildren();

  if (!books.length) {
    app.append(el('p', 'Tu cuenta todavía no tiene acceso a ningún libro. Crea uno para empezar:'));
    app.append(createBookSection(async (newId) => renderApp(newId)));
    return;
  }

  const currentBook = books.some((b) => b.book_id === selectedBookId) ? selectedBookId : books[0].book_id;
  const toolbar = el('div', undefined, 'toolbar');
  const picker = el('select');
  picker.setAttribute('aria-label', 'Libro');
  for (const b of books) {
    const opt = el('option', b.title);
    opt.value = b.book_id;
    if (b.book_id === currentBook) opt.selected = true;
    picker.append(opt);
  }
  picker.addEventListener('change', () => renderApp(picker.value).catch((err) => showError(err.message)));
  toolbar.append(picker);

  const createBox = createBookSection(async (newId) => renderApp(newId));
  createBox.style.display = 'none';
  const toggleBtn = button('Crear otro libro', '', () => {
    const open = createBox.style.display === 'none';
    createBox.style.display = open ? 'block' : 'none';
    toggleBtn.setAttribute('aria-expanded', String(open));
  });
  toggleBtn.setAttribute('aria-expanded', 'false');
  toolbar.append(toggleBtn);
  const notice = el('p', undefined, 'notice');
  notice.setAttribute('role', 'status');
  notice.hidden = true;
  app.append(toolbar, createBox, notice);

  const state = await apiState('/books/' + currentBook);
  const built = bookSections(currentBook, state.data);
  app.append(...built.nodes);
  if (seq === renderSeq) view = { book: currentBook, tag: state.tag, pending: null, sections: built.nodes, notice };
  if (selectedScene) {
    await built.openQuote(selectedScene, highlight?.quote, highlight?.anchor, highlight?.status);
  }
}

// Unfinished work a re-render would destroy: a focused field, text or files not
// yet sent, or an open dialog (the account menu included).
function hasWorkInProgress() {
  const active = document.activeElement;
  if (active && ['INPUT', 'TEXTAREA', 'SELECT'].includes(active.tagName)) return true;
  if (document.querySelector('dialog[open], [role="dialog"], [aria-modal="true"]')) return true;
  for (const input of app.getElementsByTagName('input')) {
    if (input.type === 'file' ? input.files && input.files.length > 0 : input.value !== input.defaultValue) return true;
  }
  return false;
}

// The first card at or below the top of the viewport, so the swap can keep it
// where it was and a button never moves under the pointer.
function viewportAnchor() {
  for (const card of app.getElementsByTagName('article')) {
    if (!card.id) continue;
    const top = card.getBoundingClientRect().top;
    if (top >= 0) return { id: card.id, top };
  }
  return null;
}

async function showRefreshed(current, data) {
  const seq = renderSeq;
  const scene = openScene;
  const built = bookSections(current.book, data);
  if (scene) await built.openQuote(scene.file, scene.highlight?.quote, scene.highlight?.anchor, scene.highlight?.status, true);
  // Reopening the scene took a request: the person may have started something meanwhile.
  if (seq !== renderSeq || actionsRunning > 0 || hasWorkInProgress()) return false;
  const anchor = viewportAnchor();
  const scrollY = window.scrollY;
  const focused = document.activeElement && document.activeElement.closest ? document.activeElement.closest('article') : null;
  for (const node of current.sections) node.remove();
  app.append(...built.nodes);
  current.sections = built.nodes;
  const anchored = anchor && document.getElementById(anchor.id);
  if (anchored) window.scrollBy(0, anchored.getBoundingClientRect().top - anchor.top);
  else window.scrollTo(0, scrollY);
  const refocus = focused && focused.id && document.getElementById(focused.id);
  if (refocus) refocus.focus({ preventScroll: true });
  return true;
}

// One poll. It only ever reads; it never renders over unfinished work, over a
// newer render, or while one of the person's own actions is running.
async function refreshOnce() {
  const current = view;
  if (!current || refreshing || document.hidden || actionsRunning > 0) return;
  refreshing = true;
  try {
    const state = await apiState('/books/' + current.book, current.tag);
    if (current !== view) return;
    if (state.changed) {
      current.tag = state.tag;
      current.pending = state.data;
    }
    refreshDelay = REFRESH_MS;
    if (!current.pending || actionsRunning > 0) return;
    if (hasWorkInProgress()) {
      setNotice(current.notice, true);
      return;
    }
    const data = current.pending;
    if (await showRefreshed(current, data)) {
      if (current.pending === data) current.pending = null;
      setNotice(current.notice, false);
    } else if (current === view) {
      setNotice(current.notice, true);
    }
  } catch {
    // A failed poll is not the person's problem: retry later, and less often.
    refreshDelay = Math.min(refreshDelay * 2, REFRESH_MAX_MS);
  } finally {
    refreshing = false;
  }
}

function scheduleRefresh() {
  clearTimeout(refreshTimer);
  refreshTimer = null;
  if (document.hidden) return;
  refreshTimer = setTimeout(async () => {
    await refreshOnce();
    scheduleRefresh();
  }, refreshDelay);
}

function startRefresh() {
  // A hidden tab asks for nothing; coming back asks at once instead of waiting a turn.
  document.addEventListener('visibilitychange', async () => {
    clearTimeout(refreshTimer);
    refreshTimer = null;
    if (document.hidden) return;
    await refreshOnce();
    scheduleRefresh();
  });
  scheduleRefresh();
}

window.addEventListener('load', async () => {
  try {
    await window.Clerk.load({ ui: { ClerkUI: window.__internal_ClerkUICtor } });
    if (!window.Clerk.isSignedIn) {
      const box = el('div', undefined, 'sign-in');
      app.replaceChildren(box);
      window.Clerk.mountSignIn(box);
      return;
    }
    window.Clerk.mountUserButton(document.getElementById('user'));
    startRefresh();
    await renderApp();
  } catch (error) {
    app.replaceChildren();
    showError(error.message || 'No se pudo cargar la página');
  }
});
`;
