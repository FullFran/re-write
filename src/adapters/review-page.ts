/**
 * The page a person uses to accept or reject. It holds no data: everything comes
 * from the review API after sign-in, and it is rendered with textContent, because
 * manuscripts and agent proposals are untrusted.
 */

function escapeAttribute(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

// `engine`: the embedded engine is enabled, so the page carries the assistant panel
// (its styles and script are appended to /review/app.css and /review/app.js).
export function reviewHtml(issuer: string, publishableKey: string, options: { engine?: boolean } = {}): string {
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
<body${options.engine ? ' data-assistant' : ''}>
<header><h1>RE;write</h1>${options.engine ? '<div class="header-nav"><button type="button" id="assistant-toggle" class="header-toggle" aria-controls="assistant" aria-expanded="false">Asistente</button><div id="user"></div></div>' : '<div id="user"></div>'}</header>
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
  /* Height of the section navigation while it sticks to the top; 0 where it is a side column. */
  --nav-h: calc(var(--tap) + 2 * var(--space-1));
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
.header-nav { display: flex; align-items: center; gap: var(--space-3); }
.header-nav a { display: inline-flex; align-items: center; min-height: var(--tap); padding: 0 var(--space-2); }
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
/* A jump (a navigation link, a decided card, an opened scene) lands below the navigation bar. */
section, article, .scene-viewer { scroll-margin-top: calc(var(--nav-h) + var(--space-3)); }
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
/* The way back from a decision sits under the card, quieter than the decision itself. */
.reconsider { align-items: center; }
.decision-log { margin: var(--space-3) 0; padding-left: var(--space-5); }
/* Reverting an applied change is confirmed in place, inside its card. */
.confirm { margin-top: var(--space-4); padding: var(--space-4); border: 1px solid var(--edge); border-left: 4px solid var(--reject); border-radius: var(--radius); }
.confirm > h3 { margin-top: 0; }
.scenes-grid { display: flex; flex-wrap: wrap; gap: var(--space-2); margin: var(--space-3) 0; }
.scenes-grid > button { text-align: left; }
.scene-viewer { margin-top: var(--space-4); padding-top: var(--space-4); border-top: 1px solid var(--line); }
/* The scene editor: the stored Markdown as plain text, in the manuscript's own type. */
.scene-editor-text { display: block; width: 100%; min-height: 60vh; margin: var(--space-3) 0; padding: var(--space-3); font: var(--text-md)/1.6 var(--font-prose); resize: vertical; }
.scene-conflict pre { max-height: 40vh; overflow-y: auto; }
/* The CodeMirror editor (/review/editor.js): three views of the same Markdown, chosen above it. */
.scene-cm { margin: var(--space-3) 0; border: 1px solid var(--line); border-radius: var(--radius); }
.scene-views { display: flex; flex-wrap: wrap; gap: var(--space-1); padding: var(--space-1); border-bottom: 1px solid var(--line); }
.scene-views > button { flex: 1 1 auto; padding: var(--space-1) var(--space-3); font-size: var(--text-sm); }
.scene-cm-host, .scene-reading { padding: 0 var(--space-3); }
.scene-reading { max-width: 40em; margin: 0 auto; padding-bottom: var(--space-5); font: var(--text-md)/1.7 var(--font-prose); }
.scene-reading blockquote { margin: var(--space-3) 0; padding-left: var(--space-3); border-left: 3px solid var(--line); color: var(--muted); }
.scene-reading hr { border: 0; margin: var(--space-5) 0; text-align: center; }
.scene-reading hr::after { content: '⁂'; color: var(--muted); letter-spacing: .3em; }
.scene-reading pre { white-space: pre-wrap; }

/* Modes (docs/design.md, "Modes"): the switch, and the writing desk of Concentración and Ayuda. */
.mode-switch { display: flex; flex: 1 1 100%; gap: var(--space-1); padding: var(--space-1); border: 1px solid var(--line); border-radius: var(--radius); background: var(--paper); font-family: var(--font-ui); }
.mode-switch > button { flex: 1 1 0; min-width: 0; min-height: var(--tap); padding: 0 var(--space-2); border-color: transparent; font-size: var(--text-sm); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.desk { display: none; }
body[data-mode=focus] .desk, body[data-mode=help] .desk { display: block; }
/* A writing mode shows the desk only: the review stays in the page, untouched, behind it. */
body[data-mode=focus] #app > section:not(.desk), body[data-mode=help] #app > section:not(.desk),
body[data-mode=focus] .section-nav, body[data-mode=help] .section-nav, body[data-mode=focus] .create-toggle, body[data-mode=help] .create-toggle { display: none; }
body[data-mode=focus] .toolbar, body[data-mode=help] .toolbar { margin-bottom: var(--space-3); }
.desk-head { display: flex; flex-wrap: wrap; align-items: baseline; gap: var(--space-2) var(--space-4); }
.desk-scenes { display: flex; flex: 1 1 100%; gap: var(--space-2); }
.desk-scenes > select { flex: 1 1 auto; min-width: 0; }
.desk-scenes > button { flex: none; padding: 0 var(--space-3); }
.desk-title { flex: 1 1 auto; margin: var(--space-3) 0 0; font-size: var(--text-xl); }
.desk-count { margin: 0; }
.desk-banner { margin: var(--space-3) 0; padding: var(--space-3) var(--space-4); border: 1px solid var(--edge); border-left: 4px solid var(--accept); border-radius: var(--radius); font: var(--text-sm)/1.45 var(--font-ui); }
.desk-banner[hidden], .desk-panes { display: none; }
.desk-banner > p { margin: 0 0 var(--space-2); color: var(--ink); font-weight: 400; }
/* Guardar, the save state and the formatting toolbar sit above the text and stay in reach while
   writing; with a phone keyboard open they follow the visible part of the screen (--vv-top). */
.scene-head { position: sticky; top: var(--vv-top, 0px); z-index: 2; background: var(--paper); }
.scene-head > .actions { flex-wrap: nowrap; align-items: center; margin: 0; padding: var(--space-2) 0; }
.scene-head > .actions > button { flex: none; }
.scene-head .save-status { flex: 1 1 auto; min-width: 0; margin: 0; }
.scene-format { display: flex; align-items: center; gap: var(--space-1); padding: 0 0 var(--space-2); }
.scene-format[hidden] { display: none; }
.format-toggle { display: none; }
.format-buttons { display: flex; flex-wrap: wrap; gap: var(--space-1); }
.format-buttons > button { padding: var(--space-1) var(--space-2); font-size: var(--text-sm); }
.format-buttons > [data-format=bold] { font-weight: 700; }
.format-buttons > [data-format=italic] { font-style: italic; }
.desk-help h2 { margin: var(--space-4) 0 var(--space-2); font-size: var(--text-lg); }
.desk-help h3 { margin-top: var(--space-5); }
.desk-help .ask-scene { width: 100%; }
/* Notas and Grafo (issue #115): panels over the desk's text, which stays mounted behind them. */
.desk-tools { display: flex; gap: var(--space-1); }
.desk-tools > button { min-height: var(--tap); padding: 0 var(--space-4); }
.desk-tools > button[aria-expanded=true] { background: var(--pressed); }
.desk-status { flex: 1 1 100%; margin: 0; }
/* Analizar: Ayuda only, its scope said before sending (docs/design.md, "Modes"). */
.analyse-toggle, .desk-analyse { display: none; }
body[data-mode=help] .analyse-toggle { display: inline-flex; align-items: center; }
body[data-mode=help] .desk-analyse:not([hidden]) { display: block; margin: var(--space-3) 0; padding: var(--space-3) var(--space-4); border: 1px solid var(--line); border-left: 4px solid var(--accept); border-radius: var(--radius); }
.desk-analyse h2 { margin: 0 0 var(--space-2); font-size: var(--text-lg); }
.analyse-scopes { display: flex; flex-wrap: wrap; gap: var(--space-1); }
.analyse-scopes > button { flex: 1 1 auto; }
.analyse-scope { margin: var(--space-3) 0 var(--space-1); font-weight: 600; }
.analyse-hint { margin: 0 0 var(--space-3); }
.analyse-status:empty { display: none; }
.desk-status:empty { display: none; }
body[data-mode] .desk[data-panel] .desk-body, body[data-mode] .desk[data-panel] .desk-panes { display: none; }
.desk-panel { margin: var(--space-3) 0 var(--space-6); }
.panel-head { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: var(--space-2); }
.panel-head > h2 { margin: var(--space-3) 0; font-size: var(--text-xl); }
.panel-head > h2:focus { outline: none; }
.notes-group h3 { margin: var(--space-5) 0 var(--space-2); font-size: var(--text-lg); }
.notes-list, .mentions, .graph-neighbours { list-style: none; margin: 0; padding: 0; }
.notes-list > li, .graph-neighbours > li { display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-1) var(--space-3); margin: var(--space-1) 0; }
.note-open, .graph-neighbour, .mention-source { min-height: var(--tap); text-align: left; }
.note-backlinks { margin: var(--space-5) 0; padding-top: var(--space-3); border-top: 1px solid var(--line); }
.note-backlinks h3 { margin: var(--space-4) 0 var(--space-2); font-size: var(--text-lg); }
.mentions > li { margin: var(--space-3) 0; }
.mention-context { margin: var(--space-1) 0 0; font-family: var(--font-prose); color: var(--ink); }
.graph-controls { display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-2) var(--space-5); margin: var(--space-3) 0; }
.graph-controls label { display: inline-flex; align-items: center; gap: var(--space-2); min-height: var(--tap); }
.graph-controls input[type=checkbox] { width: 22px; height: 22px; min-height: 0; padding: 0; }
.graph-table { width: 100%; border-collapse: collapse; font-variant-numeric: tabular-nums; }
.graph-table caption { text-align: left; font-weight: 700; padding: var(--space-2) 0; }
.graph-table th, .graph-table td { padding: var(--space-1) var(--space-2); border-bottom: 1px solid var(--line); text-align: left; }
.graph-table td:nth-child(3), .graph-table td:nth-child(4) { text-align: right; }
.graph-sort { min-height: var(--tap); width: 100%; border-color: transparent; background: transparent; text-align: inherit; font-weight: 700; padding: 0 var(--space-1); }
.graph-sort::after { content: ''; margin-left: var(--space-1); color: var(--muted); }
th[aria-sort=ascending] .graph-sort::after { content: '▲'; }
th[aria-sort=descending] .graph-sort::after { content: '▼'; }
.graph-node { min-height: var(--tap); width: 100%; text-align: left; border-color: transparent; background: transparent; }
.graph-table tr.selected { background: var(--pressed); }
.graph-table tr.selected .graph-node { font-weight: 700; }
.graph-detail { margin: var(--space-4) 0; padding: var(--space-3) var(--space-4); border: 1px solid var(--line); border-radius: var(--radius); }
.graph-detail h3 { margin-top: 0; }
.graph-table tr.on-path td:first-child { box-shadow: inset 4px 0 0 var(--accept); }
.graph-types { display: flex; flex-wrap: wrap; gap: 0 var(--space-4); margin: 0; padding: 0 var(--space-2); border: 1px solid var(--line); border-radius: var(--radius); }
.graph-types legend { padding: 0 var(--space-1); font-size: var(--text-sm); color: var(--muted); }
.graph-controls input[type=range] { min-height: var(--tap); width: 8rem; margin: 0; }
.graph-controls output { font-variant-numeric: tabular-nums; }
.graph-controls select { min-height: var(--tap); }
.graph-view { margin: var(--space-3) 0 var(--space-5); }
.graph-view-controls > button { min-height: var(--tap); }
.graph-canvas { position: relative; height: min(60vh, 640px); border: 1px solid var(--line); border-radius: var(--radius); background: var(--paper); overflow: hidden; }
.graph-legend { list-style: none; display: flex; flex-wrap: wrap; gap: var(--space-1) var(--space-4); margin: var(--space-2) 0; padding: 0; font-size: var(--text-sm); }
.graph-swatch { display: inline-block; width: 12px; height: 12px; margin-right: var(--space-1); border-radius: 50%; vertical-align: baseline; }
.graph-analysis { margin: var(--space-4) 0; padding: var(--space-2) var(--space-4); border: 1px solid var(--line); border-radius: var(--radius); }
.graph-analysis > summary { min-height: var(--tap); display: flex; align-items: center; font-weight: 700; cursor: pointer; }
.graph-op h3 { margin: var(--space-4) 0 var(--space-1); font-size: var(--text-lg); }
.graph-op ol, .graph-op ul { margin: var(--space-1) 0; padding-left: var(--space-5); }
.graph-op li { margin: var(--space-1) 0; }
.graph-pick { min-height: var(--tap); margin-right: var(--space-1); }
.graph-view-error { padding: var(--space-3); }
.help-status:empty { display: none; }
/* Concentración keeps the assistant one tap away, quietly: outlined, never the loudest thing on screen. */
body[data-mode=focus] .assistant-fab { border-color: var(--edge); background: var(--paper); color: var(--ink); box-shadow: none; }

/* Section navigation: one row under the thumb's reach, scrolled sideways, stuck to the top. */
.section-nav { position: sticky; top: 0; z-index: 2; margin: 0 calc(-1 * var(--gutter)); padding-top: env(safe-area-inset-top); border-bottom: 1px solid var(--line); background: var(--paper); }
.section-nav ul { position: relative; display: flex; gap: var(--space-1); margin: 0; padding: var(--space-1) var(--gutter); overflow-x: auto; overscroll-behavior-x: contain; scrollbar-width: none; list-style: none; }
.section-nav ul::-webkit-scrollbar { display: none; }
.section-nav a { display: flex; align-items: center; gap: var(--space-2); min-height: var(--tap); padding: 0 var(--space-3); border-radius: var(--radius); color: var(--muted); font: var(--text-sm)/1.3 var(--font-ui); text-decoration: none; white-space: nowrap; }
/* Where the reader is: weight and a filled shape, not colour alone. */
.section-nav a[aria-current=location] { background: var(--pressed); color: var(--ink); font-weight: 700; }
.count { min-width: 1.5rem; padding: 0 var(--space-1); border: 1px solid var(--edge); border-radius: 1rem; color: var(--ink); font-size: var(--text-xs); font-weight: 700; text-align: center; }
.count[hidden] { display: none; }

/* A section heading folds its section; the chevron points down when open. */
.fold { display: flex; align-items: center; gap: var(--space-3); width: 100%; min-height: var(--tap); padding: 0; border: 0; border-radius: 0; background: none; color: inherit; font: inherit; text-align: left; }
.fold::before { content: ''; flex: none; width: .5em; height: .5em; margin: 0 var(--space-1) .2em; border: solid var(--muted); border-width: 0 2px 2px 0; transform: rotate(45deg); transition: transform .12s; }
.fold[aria-expanded=false]::before { margin-bottom: 0; transform: rotate(-45deg); }
section:has(> .fold-body[hidden]) > h2 { margin-bottom: 0; }
section:has(> .fold-body[hidden]) > .toolbar { margin-bottom: 0; padding-bottom: 0; border-bottom: 0; }
section:not(.card-box):has(> .fold-body[hidden]) + section:not(.card-box) > h2 { margin-top: var(--space-2); }

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
main:has(> .section-nav) > [role=alert]:first-child { top: calc(var(--nav-h) + max(var(--space-2), env(safe-area-inset-top))); }
[role=status] { color: var(--accept); font-weight: 600; }
/* The refresh notice floats, so showing or hiding it never moves the text being read. */
.notice { position: fixed; z-index: 2; top: calc(var(--nav-h) + max(var(--space-2), env(safe-area-inset-top))); left: 0; right: 0; width: min(100% - 2 * var(--gutter), var(--measure) - 2 * var(--space-4)); margin: 0 auto; padding: var(--space-3) var(--space-4); border: 1px solid var(--edge); border-left: 4px solid var(--accept); border-radius: var(--radius); background: var(--paper); box-shadow: 0 2px 10px rgb(0 0 0 / .2); color: var(--ink); font: var(--text-sm)/1.45 var(--font-ui); }
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
  /* The mode switch is a dock under the thumb; what sticks or floats at the bottom stops above it. */
  body[data-mode] { --dock-h: calc(var(--tap) + 2 * var(--space-1) + env(safe-area-inset-bottom)); }
  .mode-switch { position: fixed; z-index: 3; left: 0; right: 0; bottom: 0; padding: var(--space-1) var(--gutter) max(var(--space-1), env(safe-area-inset-bottom)); border-width: 1px 0 0; border-radius: 0; }
  body[data-mode] .decision { bottom: var(--dock-h); }
  body[data-mode] .assistant-fab { margin-bottom: var(--dock-h); }
  body[data-mode]::after { content: ''; display: block; height: var(--dock-h); }
  .desk-scenes > button { width: var(--tap); padding: 0; font-size: var(--text-lg); }
  /* Formatting folds behind one button; open, its buttons scroll sideways in one row. */
  .format-toggle { display: inline-flex; align-items: center; flex: none; }
  .scene-format { flex-wrap: nowrap; }
  .scene-format:not([data-open=true]) > .format-buttons { display: none; }
  .format-buttons { flex: 1 1 auto; flex-wrap: nowrap; min-width: 0; overflow-x: auto; overscroll-behavior-x: contain; }
  .format-buttons > button { flex: none; }
  /* With the keyboard open the dock and the floating button give the room to the text. */
  body.keyboard-open .mode-switch, body.keyboard-open .assistant-fab { display: none; }
  body.keyboard-open::after { height: 0; }
  .desk-scenes > button > span { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
}
/* Phones and tablets in Ayuda: the text and the help are two panes, one tap apart. */
@media (max-width: 63.99em) {
  body[data-mode=help] .desk-panes { display: flex; gap: var(--space-1); margin: var(--space-3) 0; }
  .desk-panes > button { flex: 1 1 0; }
  .desk[data-pane=help] .desk-editor, .desk[data-pane=text] .desk-help { display: none; }
}
/* Wide screens in Ayuda: the editor in the centre, the help in a column on its right. */
@media (min-width: 64em) {
  .mode-switch { flex: none; margin-left: auto; }
  .mode-switch > button { flex: none; padding: 0 var(--space-3); }
  body[data-mode=help] main { max-width: 84rem; }
  body[data-mode=help] header { padding-left: max(var(--gutter), calc((100% - 84rem) / 2 + var(--gutter))); padding-right: max(var(--gutter), calc((100% - 84rem) / 2 + var(--gutter))); }
  body[data-mode=help] .desk-body { display: grid; grid-template-columns: minmax(0, 1fr) minmax(18rem, 24rem); gap: var(--space-6); align-items: start; }
  body[data-mode=help] .desk-help { position: sticky; top: var(--space-3); max-height: calc(100vh - 2 * var(--space-3)); overflow-y: auto; padding-right: var(--space-1); }
}
/* With the assistant open beside the page there is room for one column only: the help goes under the text. */
@media (max-width: 99.99em) and (min-width: 75em) {
  body.assistant-open[data-mode=help] .desk-body { display: block; }
  body.assistant-open[data-mode=help] .desk-help { position: static; max-height: none; }
}
/* Tablet and desktop: the same column, with more air. */
@media (min-width: 48em) {
  main { padding-top: var(--space-6); }
  article, .card-box { padding: var(--space-5); }
  .card-box article { padding: var(--space-5) 0; }
}
/* Wide screens have room beside the column: the navigation becomes a list there and covers nothing. */
@media (min-width: 75em) {
  :root { --nav-h: 0px; }
  .section-nav { position: fixed; top: 5.5rem; left: calc(50% - var(--measure) / 2 - 14rem); width: 12rem; max-height: calc(100vh - 6.5rem); margin: 0; padding: 0; border: 0; overflow-y: auto; }
  .section-nav ul { flex-direction: column; padding: 0; overflow: visible; }
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
// Items decided in this tab, as 'claim:<book>/<id>' or 'proposal:<book>/<id>': their card
// says "Decisión guardada · Deshacer" until the decision is taken back or the page reloads.
const justDecided = new Set();
// The book's proposals by id, so a card can tell whether its revert is pending or done.
let proposalIndex = new Map();
const STALE_MESSAGE = 'Esta decisión cambió en otra pestaña. Recarga para ver el estado actual.';
const MAX_NOTE = 2000;
let nextNoteCounter = 0;
// Background refresh: the page asks for the queue again every few seconds while it
// is visible, and the server answers 304 when nothing changed.
const REFRESH_MS = 5000;
const REFRESH_MAX_MS = 60000;
let view = null;
let openScene = null;
// The newest book data the page shows, and the title of its book, for the assistant panel.
let latestQueue = null;
let currentBookTitle = '';
// The assistant panel, when the engine is enabled (src/adapters/engine-page.ts sets it).
let assistant = null;
let renderSeq = 0;
// The book the person chose last, by its id. Every render and every reload after an
// action follows it, so a late answer for another book never brings that book back.
let selectedBook = null;
const BOOK_KEY = 'rewrite.book';
const GONE_NOTICE = 'El libro que tenías abierto ya no está disponible o ya no tienes acceso. Te mostramos ';
let actionsRunning = 0;
let refreshTimer = null;
let refreshDelay = REFRESH_MS;
let refreshing = false;
// Sections the person folded or unfolded by hand: a choice outlives every re-render.
const foldChoices = new Map();
// The navigation row: [section key, short label, the section's own heading].
const NAV = [
  ['cambios', 'Cambios', 'Cambios propuestos'],
  ['hallazgos', 'Hallazgos', 'Hallazgos de la trama'],
  ['problemas', 'Problemas', 'Posibles problemas'],
  ['afirmaciones', 'Afirmaciones', 'Afirmaciones por revisar'],
  ['importar', 'Importar', 'Importar escenas Markdown'],
  ['escenas', 'Escenas', 'Navegar escenas'],
  ['canon', 'Canon', 'Canon'],
  ['historial', 'Historial', 'Historial de cambios del manuscrito'],
];
// A section is the current one once its heading has passed this line, in px from the top.
const SPY_LINE = 120;
let spyQueued = false;
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

// A decision carries the history length this tab saw, so a tab opened before another
// tab reopened or decided the item is refused (409) instead of deciding on old state.
async function decideCard(kind, book, id, decision, card, reload, history) {
  await api('/books/' + book + '/' + kind + 's/' + id, { decision, expected: (history || []).length });
  (kind === 'claim' ? decidedClaims : decidedProposals).add(book + '/' + id);
  const key = kind + ':' + book + '/' + id;
  justDecided.add(key);
  await reload();
  focusItem(card.id, key);
}

// Puts focus on an item's card after a re-render: the same card when it is still there,
// otherwise the first card of the same item (a reopened claim moves out of Canon, a
// reopened proposal out of Historial). Its folded section opens first.
function focusItem(cardId, key) {
  let card = cardId ? document.getElementById(cardId) : null;
  if (!card && key && app.getElementsByTagName) {
    const suffix = itemId(key);
    card = [...app.getElementsByTagName('article')].find((n) => n.id === suffix || n.id.endsWith('-' + suffix)) || null;
  }
  if (!card) return null;
  const box = card.closest ? card.closest('section') : null;
  if (box && box.fold) box.fold.setOpen(true);
  card.focus({ preventScroll: true });
  card.scrollIntoView({ block: 'nearest' });
  return card;
}

// 'proposal:sal/P-1' -> 'proposal-sal-P-1', the id its card is built with.
function itemId(key) {
  return key.replace(':', '-').replace('/', '-');
}

const when = (at) => new Date(at).toLocaleString('es');

// A link to another item of the book; it moves focus to that item's card.
function itemLink(kind, book, id) {
  const link = el('a', id);
  link.href = '#' + kind + '-' + book + '-' + id;
  link.addEventListener('click', (event) => {
    // The address stays as it is: Clerk's components route through the hash.
    event.preventDefault();
    focusItem(null, kind + ':' + book + '/' + id);
  });
  return link;
}

// Every decision on a claim or proposal, oldest first. History only grows, so taking a
// decision back shows as one more line: accepted, revert asked, new decision.
function decisionLog(kind, book, entries) {
  const list = el('ol', undefined, 'meta decision-log');
  list.setAttribute('aria-label', 'Historial de decisiones');
  for (const entry of entries) {
    const word = entry.action === 'revert' ? 'Reversión pedida' : entry.action === 'reopen' || entry.to === 'proposed' ? 'Reabierta' : entry.to === 'accepted' ? 'Aceptada' : 'Rechazada';
    const line = el('li', word + ' por ' + entry.by + ' · ' + when(entry.at));
    if (entry.action === 'revert' && entry.ref) line.append(document.createTextNode(' · propuesta inversa '), itemLink(kind, book, entry.ref));
    if (entry.note) line.append(document.createTextNode(' · Nota: "' + entry.note + '"'));
    list.append(line);
  }
  return list;
}

// The way back from a decision. Right after deciding, the card says the decision is saved
// and offers "Deshacer" (no timer); otherwise the action is named by what it does.
// savedKey is the item's key on the card that keeps this tab's decisions, '' elsewhere.
function reconsiderRow(savedKey, label, run, inHistory) {
  const row = el('div', undefined, 'actions reconsider');
  const saved = !inHistory && justDecided.has(savedKey);
  if (saved) row.append(el('span', 'Decisión guardada ·', 'meta saved'));
  const shown = saved ? 'Deshacer' : inHistory ? 'Volver a revisar' : label;
  const action = button(shown, '', run);
  // The spoken name starts with the visible words, then says what the action does.
  if (shown !== label) action.setAttribute('aria-label', shown + ': ' + label.toLowerCase());
  row.append(action);
  return row;
}

// Takes back an editorial decision: the item is pending again and the text never changes.
async function reopenItem(path, expected, key, card, reload) {
  await api(path + '/reopen', { expected });
  justDecided.delete(key);
  await reload();
  focusItem(card.id, key);
}

function el(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}

function showError(message, retry) {
  const alert = el('p', message);
  alert.setAttribute('role', 'alert');
  if (retry) {
    alert.append(document.createTextNode(' '), button('Recargar', '', async () => {
      alert.remove();
      await retry();
    }));
  }
  app.prepend(alert);
}

// Another tab changed the item since this one was rendered: the way out is a reload.
function errorShown(error) {
  const stale = error.status === 409 && error.message === STALE_MESSAGE;
  showError(error.message, stale ? () => renderApp(selectedBook) : undefined);
}

// The book named in the address (?book=<id>), else the last one chosen in this browser.
// Both are only a preference: the list of books the server returns decides, and the
// server checks access on every request. The hash belongs to Clerk and is never used.
function preferredBook() {
  try {
    const named = new URLSearchParams(window.location.search).get('book');
    if (named) return named;
  } catch {}
  try {
    return window.localStorage.getItem(BOOK_KEY);
  } catch {
    return null;
  }
}

function recordBook(book) {
  try {
    window.localStorage.setItem(BOOK_KEY, book);
  } catch {}
  try {
    const params = new URLSearchParams(window.location.search);
    if (params.get('book') === book) return;
    params.set('book', book);
    window.history.replaceState(window.history.state, '', window.location.pathname + '?' + params.toString() + window.location.hash);
  } catch {}
}

function httpError(res, data) {
  const error = new Error(data.error || 'No se pudo completar la operación');
  error.status = res.status;
  return error;
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
  if (!res.ok) throw httpError(res, data);
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
  if (!res.ok) throw httpError(res, data);
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
  if (!res.ok) throw httpError(res, data);
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
      errorShown(error);
    } finally {
      // Not every action re-renders the page: a button that stays must work again.
      node.disabled = false;
      actionsRunning--;
    }
  });
  return node;
}

// "Preguntar al asistente" on a card, only when the panel exists. The label stays in the
// browser; the server is told the kind and id of the item and nothing else.
function askButton(card, item, draft) {
  card.setAttribute('data-item', item.kind + ':' + item.id);
  if (!assistant) return;
  const ask = el('button', 'Preguntar al asistente', 'ask-assistant');
  ask.type = 'button';
  ask.setAttribute('aria-label', 'Preguntar al asistente sobre: ' + item.label);
  ask.addEventListener('click', () => assistant.ask(item, draft, ask));
  card.prepend(ask);
}

const shortText = (value) => {
  const text = String(value || '');
  return text.length > 60 ? text.slice(0, 57) + '…' : text;
};

// A quote that does something when clicked, from the keyboard too (Enter or Space).
function clickable(node, open) {
  node.className = 'clickable-quote';
  node.tabIndex = 0;
  node.addEventListener('click', open);
  node.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    open();
  });
}

function quote(text, detail) {
  const box = el('div');
  box.append(el('blockquote', text), el('p', detail, 'meta'));
  return box;
}

function claimCard(book, claim, reload, inSession) {
  const card = el('article');
  card.id = 'claim-' + book + '-' + claim.claim_id;
  card.tabIndex = -1;
  card.append(stateBadge(claim.editorial_status), el('p', claim.statement));
  const reason = outsideCanonReason(claim);
  if (reason) card.append(el('p', 'Fuera del Canon: ' + reason, 'meta'));
  card.append(quote(claim.anchor.quote, claim.source_file + ' · ' + claim.epistemic_kind + ' · evidencia: ' + claim.evidence_status + ' · propuesto por: ' + claim.extractor));
  if (claim.uncertainty) card.append(el('p', 'Incertidumbre: ' + claim.uncertainty, 'meta'));
  askButton(card, { kind: 'claim', id: claim.claim_id, label: 'Afirmación: ' + shortText(claim.statement) },
    '¿Esta afirmación está bien apoyada por el texto? ¿Contradice algo del libro?');
  const history = claim.history || [];
  if (history.length) card.append(decisionLog('claim', book, history));
  const key = 'claim:' + book + '/' + claim.claim_id;
  if (claim.editorial_status === 'proposed') {
    const actions = el('div', undefined, 'actions decision');
    const decide = (decision) => () => decideCard('claim', book, claim.claim_id, decision, card, reload, history);
    if (claim.evidence_status === 'valid') actions.append(button('Aceptar', 'accept', decide('accept')));
    actions.append(button('Rechazar', 'reject', decide('reject')));
    card.append(actions);
  } else {
    // Accepting a claim changes no text, so either decision is taken back the same way.
    card.append(reconsiderRow(inSession ? key : '', 'Deshacer decisión editorial',
      () => reopenItem('/books/' + book + '/claims/' + claim.claim_id, history.length, key, card, reload)));
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
  askButton(card, { kind: 'narrative_finding', id: finding.finding_id, label: 'Hallazgo: ' + shortText(finding.statement) },
    '¿En qué te basas para este hallazgo? ¿Qué escenas lo apoyan o lo contradicen?');

  if (finding.characters && finding.characters.length) {
    card.append(el('p', 'Personajes: ' + finding.characters.join(', '), 'meta'));
  }
  card.append(el('p', 'Propuesto por: ' + finding.author, 'meta'));

  for (const ev of finding.evidence) {
    const evBox = el('div');
    const quoteEl = el('blockquote', ev.quote, 'clickable-quote');
    quoteEl.title = 'Haz clic para ver y resaltar esta cita en la escena';
    if (openQuote) clickable(quoteEl, () => openQuote(ev.file, ev.quote, ev.anchor, ev.status));
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
  card.append(...findingReconsider(book, finding, reload));

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

// A verdict is taken back like any editorial decision. While it is reopened the finding is
// pending again and the earlier verdict stays in view, so nothing is lost.
function findingReconsider(book, finding, reload) {
  const kept = finding.reopened_verdict;
  const record = finding.verdict || kept;
  // Earlier verdicts, oldest first, with who took each back: the record only grows.
  const earlier = record && record.history ? record.history : [];
  const log = [];
  if (earlier.length) {
    const list = el('ol', undefined, 'meta decision-log');
    list.setAttribute('aria-label', 'Valoraciones anteriores');
    for (const entry of earlier) {
      let text = '«' + (VERDICTS[entry.verdict] || entry.verdict) + '» por ' + entry.by + ' · ' + when(entry.at);
      if (entry.reopened) text += ' · reabierta por ' + entry.reopened.by + ' · ' + when(entry.reopened.at);
      list.append(el('li', text));
    }
    log.push(list);
  }
  if (kept) {
    return [...log, el('p', 'Valoración reabierta: antes «' + (VERDICTS[kept.verdict] || kept.verdict) + '», por ' + kept.by + ' el ' + when(kept.at) + '. Vuelve a estar pendiente.', 'meta')];
  }
  if (!finding.verdict) return log;
  return [...log, reconsiderRow('', 'Deshacer decisión editorial', async () => {
    await api('/books/' + book + '/findings/' + finding.finding_id + '/reopen', { expected: finding.verdict.at });
    await reload();
  })];
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
  askButton(card, { kind: 'finding', id: finding.finding_id, label: 'Posible problema: ' + shortText(finding.explanation) },
    '¿Es un error real o puede ser intencionado? Explícamelo con las citas.');
  for (const c of finding.citations) card.append(quote(c.quote, c.source_file + ' · momento de la historia: ' + (c.story_time ?? 'desconocido') + ' · evidencia: ' + c.evidence_status));
  const others = el('ul', undefined, 'meta');
  for (const alternative of finding.alternatives) others.append(el('li', alternative));
  card.append(others);
  if (finding.verdict) card.append(el('p', 'Decisión: ' + (VERDICTS[finding.verdict.verdict] || finding.verdict.verdict), 'meta'));
  card.append(...findingReconsider(book, finding, reload));
  const actions = el('div', undefined, 'actions');
  for (const [verdict, label] of Object.entries(VERDICTS)) {
    actions.append(button(label, '', () => api('/books/' + book + '/findings/' + finding.finding_id, { verdict }).then(() => reload())));
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

// A line naming the proposal this one comes from, with a link to it.
function origin(book, text, id, end) {
  const line = el('p', text, 'meta origin');
  line.append(itemLink('proposal', book, id), document.createTextNode(end));
  return line;
}

// place: 'session' in Cambios propuestos (it keeps this tab's decisions), 'history' in
// Historial, nothing elsewhere (the scene viewer).
function proposalCard(book, { proposal, diff, applicable }, reload, place) {
  const card = el('article');
  card.id = 'proposal-' + book + '-' + proposal.proposal_id;
  card.tabIndex = -1;
  card.append(stateBadge(proposal.status, proposal.status === 'proposed' && !applicable));
  if (proposal.reverts) card.append(origin(book, 'Revierte el cambio aceptado ', proposal.reverts, '. Aceptarla devuelve ese pasaje a como estaba.'));
  if (proposal.reproposes) card.append(origin(book, 'Vuelve a proponer el cambio ', proposal.reproposes, ', frente al texto actual.'));
  card.append(el('p', proposal.rationale), visualDiff(diff));
  askButton(card, { kind: 'proposal', id: proposal.proposal_id, label: 'Cambio propuesto · ' + String(proposal.file || '').replace(/^scenes\//, '') },
    '¿Qué gana la escena con este cambio? ¿Hay algo que deba revisar antes de aceptarlo?');
  const history = proposal.history || [];
  if (history.length) card.append(decisionLog('proposal', book, history));
  if (proposal.status !== 'proposed') {
    if (proposal.result_commit) card.append(el('p', 'Cambio aprobado del manuscrito · versión ' + proposal.result_commit.slice(0, 10), 'meta'));
    card.append(...proposalReconsider(book, proposal, card, reload, place));
    return card;
  }
  const actions = el('div', undefined, 'actions decision');
  const decide = (decision) => () => decideCard('proposal', book, proposal.proposal_id, decision, card, reload, history);
  if (applicable) actions.append(button('Aceptar cambio', 'accept', decide('accept')));
  else card.append(el('p', 'La escena ha cambiado desde esta propuesta: ya no se puede aplicar.', 'meta'));
  actions.append(button('Rechazar', 'reject', decide('reject')));
  card.append(actions);
  return card;
}

// The way back from a decided proposal. A rejection is an editorial decision and is
// reopened. An accepted change already wrote the text, so it is undone by an inverse
// proposal a person accepts; once that is accepted, the change can be proposed again.
function proposalReconsider(book, proposal, card, reload, place) {
  const key = 'proposal:' + book + '/' + proposal.proposal_id;
  const savedKey = place === 'session' ? key : '';
  const inHistory = place === 'history';
  const path = '/books/' + book + '/proposals/' + proposal.proposal_id;
  const history = proposal.history || [];
  if (proposal.status === 'rejected') {
    return [reconsiderRow(savedKey, 'Deshacer decisión editorial', () => reopenItem(path, history.length, key, card, reload), inHistory)];
  }
  const revert = history.filter((entry) => entry.action === 'revert').at(-1);
  const inverse = revert ? proposalIndex.get(revert.ref) : null;
  if (inverse && inverse.status === 'proposed') {
    return [origin(book, 'Reversión pendiente: el texto vuelve atrás cuando una persona acepte la propuesta inversa ', inverse.proposal_id, '.')];
  }
  if (inverse && inverse.status === 'accepted') {
    const again = [...proposalIndex.values()].find((other) => other.reproposes === proposal.proposal_id && other.status !== 'rejected');
    if (again) return [origin(book, 'Cambio revertido y propuesto de nuevo en ', again.proposal_id, '.')];
    const row = el('div', undefined, 'actions reconsider');
    row.append(el('span', 'Cambio revertido.', 'meta'), button('Volver a proponer', '', async () => {
      const result = await api(path + '/repropose', {});
      await reload();
      focusItem(null, 'proposal:' + book + '/' + result.proposal.proposal_id);
    }));
    return [row];
  }
  // Accepted and not reverted, or its inverse was rejected: a new revert reopens that one.
  const row = reconsiderRow(savedKey, 'Revertir cambio de texto', () => confirmRevert(book, proposal, card, row.children[row.children.length - 1], reload, key), inHistory);
  return [row];
}

// Reverting an applied change asks first and says exactly what will happen. The box is a
// dialog only while it is open, so the background refresh waits for it and never removes it.
function confirmRevert(book, proposal, card, opener, reload, key) {
  if (card.confirming) return;
  const box = el('div', undefined, 'confirm');
  box.setAttribute('role', 'dialog');
  const title = el('h3', 'Revertir cambio de texto');
  title.id = card.id + '-revert';
  title.tabIndex = -1;
  box.setAttribute('aria-labelledby', title.id);
  box.append(title,
    el('p', 'Se creará una propuesta inversa que deshace este cambio. El texto no cambia hasta que una persona la acepte en «Cambios propuestos».'),
    el('p', 'Si después se editó este mismo pasaje, no se puede revertir de forma automática y habrá que proponer el cambio a mano.', 'meta'));
  const close = () => {
    box.remove();
    card.confirming = null;
  };
  const cancel = () => {
    close();
    opener.focus();
  };
  const actions = el('div', undefined, 'actions');
  actions.append(
    button('Crear propuesta inversa', 'accept', async () => {
      const result = await api('/books/' + book + '/proposals/' + proposal.proposal_id + '/revert', { expected: (proposal.history || []).length });
      close();
      justDecided.delete(key);
      await reload();
      focusItem(null, 'proposal:' + book + '/' + result.proposal.proposal_id);
    }),
    button('Cancelar', '', cancel),
  );
  box.append(actions);
  box.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') cancel();
  });
  card.append(box);
  card.confirming = box;
  title.focus();
}

function section(title, cards, empty, explanation) {
  const box = el('section');
  box.append(el('h2', title));
  // An empty section is one line: what it holds is explained once it holds something.
  if (explanation && cards.length) box.append(el('p', explanation, 'meta'));
  if (!cards.length) box.append(el('p', empty, 'meta'));
  for (const card of cards) {
    if (card.id) card.id = encodeURIComponent(title) + '-' + card.id;
  }
  box.append(...cards);
  return box;
}

function isPhone() {
  return Boolean(window.matchMedia && window.matchMedia('(max-width: 40em)').matches);
}

// Turns a built section into one its heading folds. Folded content stays in the
// page, so a form keeps its text and files. The heading keeps its exact text.
function foldable(box, key, openByDefault) {
  const head = box.children[0];
  const heading = head.className === 'toolbar' ? head.children[0] : head;
  const toggle = el('button', heading.textContent, 'fold');
  toggle.type = 'button';
  heading.textContent = '';
  heading.append(toggle);
  const body = el('div', undefined, 'fold-body');
  box.id = 'sec-' + key;
  body.id = box.id + '-body';
  toggle.setAttribute('aria-controls', body.id);
  body.append(...[...box.children].slice(1));
  box.replaceChildren(head, body);
  const show = (open) => {
    body.hidden = !open;
    toggle.setAttribute('aria-expanded', String(open));
  };
  show(foldChoices.has(key) ? foldChoices.get(key) : openByDefault);
  const setOpen = (open) => {
    foldChoices.set(key, open);
    show(open);
  };
  toggle.addEventListener('click', () => {
    setOpen(body.hidden);
    queueSpy();
  });
  box.fold = { setOpen, toggle };
  return box;
}

function goToSection(key) {
  const target = document.getElementById('sec-' + key);
  if (!target) return;
  if (target.fold) target.fold.setOpen(true);
  target.scrollIntoView({ behavior: scrollBehavior(), block: 'start' });
  // Keyboard and screen reader continue from the section, not from the navigation.
  if (target.fold) target.fold.toggle.focus({ preventScroll: true });
  if (view && view.nav) view.nav.setCurrent(key);
}

// Built once per render and kept through a background refresh, which only
// updates its counts: a link keeps its focus and the row keeps its scroll.
function sectionNav() {
  const node = el('nav', undefined, 'section-nav');
  node.setAttribute('aria-label', 'Secciones');
  const list = el('ul');
  const links = new Map();
  for (const [key, label, title] of NAV) {
    const link = el('a');
    link.href = '#sec-' + key;
    const count = el('span', undefined, 'count');
    count.hidden = true;
    link.append(el('span', label), count);
    link.setAttribute('aria-label', title);
    link.setAttribute('aria-current', 'false');
    link.addEventListener('click', (event) => {
      // The address stays as it is: Clerk's components route through the hash.
      event.preventDefault();
      goToSection(key);
    });
    const item = el('li');
    item.append(link);
    list.append(item);
    links.set(key, { link, count, title });
  }
  node.append(list);
  let current = null;
  return {
    node,
    setCounts(counts) {
      for (const [key, { link, count, title }] of links) {
        const pending = counts[key] || 0;
        count.hidden = !pending;
        count.textContent = pending ? String(pending) : '';
        link.setAttribute('aria-label', pending ? title + ': ' + pending + (pending === 1 ? ' pendiente' : ' pendientes') : title);
      }
    },
    setCurrent(key) {
      if (key === current) return;
      current = key;
      for (const [other, { link }] of links) link.setAttribute('aria-current', other === key ? 'location' : 'false');
      // Keep the current link in sight inside the row.
      const link = links.get(key).link;
      if (typeof link.offsetLeft !== 'number') return;
      const left = link.offsetLeft - 16;
      const right = link.offsetLeft + link.offsetWidth + 16;
      if (left < list.scrollLeft) list.scrollLeft = left;
      else if (right > list.scrollLeft + list.clientWidth) list.scrollLeft = right - list.clientWidth;
    },
  };
}

// Marks the section being read: the last one whose heading has passed the line.
function syncNav() {
  spyQueued = false;
  if (!view || !view.nav) return;
  let current = NAV[0][0];
  for (const [key] of NAV) {
    const target = document.getElementById('sec-' + key);
    if (target && target.getBoundingClientRect && target.getBoundingClientRect().top <= SPY_LINE) current = key;
  }
  const root = document.documentElement;
  if (root && window.scrollY > 0 && window.innerHeight + window.scrollY >= root.scrollHeight - 2) current = NAV[NAV.length - 1][0];
  view.nav.setCurrent(current);
}

function queueSpy() {
  if (spyQueued || !window.requestAnimationFrame) return;
  spyQueued = true;
  window.requestAnimationFrame(syncNav);
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

// The scene editor (issue #101): the scene's Markdown exactly as stored. Saving sends the
// version it started from; the server refuses the save when the scene changed meanwhile, and
// the person's text stays in the editor. The editor itself is CodeMirror, loaded from
// /review/editor.js (built from editor/), with three views of the same text; when that module
// is missing or fails to load, a plain text field takes its place with the same behaviour.
const SCENE_EDITOR_CLASS = 'scene-editor-text';
let unsavedEdit = null;

// What this tab keeps (scene drafts, the assistant's transcript) is keyed by a hash of the
// signed-in person, so another person in the same tab never sees it; when the person
// changes, what the tab kept for the previous one is removed. No person, nothing kept.
let personKey = null;
const PERSON_MARK = 'rewrite:person';
const TAB_PREFIXES = ['rewrite:draft:', 'rewrite.assistant.'];

function forgetTab(prefixes) {
  try {
    const store = window.sessionStorage;
    const keys = [];
    for (let i = 0; i < store.length; i++) {
      const key = store.key(i);
      if (key && prefixes.some((prefix) => key.startsWith(prefix))) keys.push(key);
    }
    for (const key of keys) store.removeItem(key);
  } catch {
    // No storage: nothing was kept.
  }
}

async function rememberPerson() {
  let key = null;
  try {
    const token = await window.Clerk.session.getToken();
    const claims = JSON.parse(atob(String(token).split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
    if (typeof claims.sub === 'string' && claims.sub) {
      const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode('rewrite:person:' + claims.sub));
      key = Array.from(new Uint8Array(digest).slice(0, 16), (byte) => byte.toString(16).padStart(2, '0')).join('');
    }
  } catch {
    key = null;
  }
  personKey = key;
  try {
    if (window.sessionStorage.getItem(PERSON_MARK) !== key) forgetTab(TAB_PREFIXES);
    if (key) window.sessionStorage.setItem(PERSON_MARK, key);
    else window.sessionStorage.removeItem(PERSON_MARK);
  } catch {
    // No storage: nothing to keep or to forget.
  }
  return key;
}

// The editor module, asked for once per page. null means the plain text field.
const EDITOR_LOAD_MS = 10000;
let editorModule = null;
function loadEditorModule() {
  if (!editorModule) {
    // A module that never arrives counts as missing, so Editar escena always opens something.
    const late = new Promise((resolve) => setTimeout(() => resolve(null), EDITOR_LOAD_MS));
    const loaded = import('/review/editor.js')
      .then((mod) => typeof mod.createSceneEditor === 'function' ? mod : null)
      .catch(() => null);
    editorModule = Promise.race([loaded, late]);
  }
  return editorModule;
}

// The view the person chose last ("live", "source" or "reading"), kept in this browser under
// the same hash of the signed-in person as the drafts (rememberPerson).
function viewKey() {
  return 'rewrite:editor-view:' + (personKey || '');
}
function readView() {
  try {
    return window.localStorage.getItem(viewKey()) || 'live';
  } catch {
    return 'live';
  }
}
function writeView(view) {
  try {
    window.localStorage.setItem(viewKey(), view);
  } catch {
    // No storage: the view is only remembered while the editor stays open.
  }
}

// The slice 1 editor, a plain text field, behind the same surface as the CodeMirror one.
function plainSurface({ text, label, onChange, onSave }) {
  const area = el('textarea', undefined, SCENE_EDITOR_CLASS);
  area.setAttribute('aria-label', label);
  area.spellcheck = true;
  area.value = text;
  area.addEventListener('input', onChange);
  area.addEventListener('keydown', (event) => {
    if ((event.ctrlKey || event.metaKey) && (event.key === 's' || event.key === 'S')) {
      event.preventDefault();
      onSave();
    }
  });
  return {
    dom: area,
    getValue: () => area.value,
    setValue(value) { area.value = value; },
    setEditable(editable) { area.readOnly = !editable; },
    isEditable: () => !area.readOnly,
    focus: () => area.focus(),
    getSelection() {
      const from = Math.min(area.selectionStart || 0, area.selectionEnd || 0);
      const to = Math.max(area.selectionStart || 0, area.selectionEnd || 0);
      return { from, to, text: area.value.slice(from, to) };
    },
    select(from, to) {
      area.focus();
      area.setSelectionRange(from, to);
    },
    destroy() {},
  };
}

// The unsaved text survives a re-render or a reload of this tab, never the tab itself.
function draftKey(book, file) { return 'rewrite:draft:' + personKey + ':' + book + ':' + file; }
function readDraft(book, file) {
  if (!personKey) return null;
  try {
    const raw = window.sessionStorage.getItem(draftKey(book, file));
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}
function writeDraft(book, file, draft) {
  if (!personKey) return;
  try {
    if (draft) window.sessionStorage.setItem(draftKey(book, file), JSON.stringify(draft));
    else window.sessionStorage.removeItem(draftKey(book, file));
  } catch {
    // No storage (a private window, a full quota): the text still stays in the field.
  }
}

// A save can be refused with the current text in the answer, so this returns status and body.
async function apiSave(path, body) {
  const token = await window.Clerk.session.getToken();
  const res = await fetch('/review/api' + path, {
    method: 'POST',
    headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, data };
}

// How a text breaks its lines: only \n, only \r\n, or a mix (a lone \r counts as a mix).
// A text field shows every break as \n, so only the first two can be edited without
// rewriting the breaks the person never touched.
function lineEndings(text) {
  const crlf = (text.match(/\r\n/g) || []).length;
  const cr = (text.match(/\r/g) || []).length;
  const lf = (text.match(/\n/g) || []).length;
  if (cr === 0) return 'lf';
  return crlf === cr && crlf === lf ? 'crlf' : 'mixed';
}

// A note is a file in notas/ (issue #115): it opens in the same editor, saved through the same
// code below, to its own route. The note's name is its file name without .md.
const isNoteFile = (file) => /^notas\//.test(String(file));
const noteFile = (name) => 'notas/' + name + '.md';
const noteName = (file) => String(file).replace(/^notas\//, '').replace(/\.md$/, '');
function docPath(book, file) {
  return isNoteFile(file)
    ? '/books/' + book + '/notes/' + encodeURIComponent(noteName(file))
    : '/books/' + book + '/scenes/' + encodeURIComponent(file);
}

// onText runs after every change of the text, by the person or by loading a saved version.
// links ({ notes, onOpenNote }) are the book's notes for wikilinks and what following one does.
function sceneEditor(book, scene, close, editorLib, onText, links) {
  const file = scene.file;
  const isNote = isNoteFile(file);
  // The text as the field shows it: every line break as \n.
  const shown = (text) => text.replace(/\r\n?/g, '\n');
  let endings = 'lf';
  let base = scene.blob;
  let savedShown = '';
  let normalising = false;
  let saving = false;
  const stored = (value) => endings === 'crlf' ? value.replace(/\n/g, '\r\n') : value;
  const box = el('div', undefined, 'scene-editor');
  // The sticky head above the text (Guardar, the save state, the toolbar), set below.
  let head = null;
  const surfaceOptions = { text: '', label: (isNote ? 'Texto de la nota ' + noteName(file) : 'Texto de la escena ' + file), onChange: () => remember(), onSave: () => save() };
  const linkOptions = links ? { notes: links.notes || [], onOpenNote: links.onOpenNote } : {};
  const area = editorLib
    ? editorLib.createSceneEditor({ ...surfaceOptions, ...linkOptions, view: readView(), onViewChange: writeView, margins: () => editorMargins(head) })
    : plainSurface(surfaceOptions);
  box.focusEditor = () => area.focus();
  const mixedNote = el('p', 'Esta escena mezcla finales de línea (de Windows y de otros sistemas). Para no cambiarlos sin querer, solo se puede leer aquí.', 'meta');
  const normalise = button('Normalizar los finales de línea y editar', '', async () => {
    endings = 'lf';
    normalising = true;
    setEditable(true);
    remember();
    status.textContent = 'Al guardar, todos los finales de línea de la escena quedarán normalizados.';
    area.focus();
  });
  const saveButton = button('Guardar', 'accept', () => save());
  const status = el('p', '', 'meta save-status');
  status.setAttribute('role', 'status');
  const conflict = el('div', undefined, 'scene-conflict');
  conflict.hidden = true;
  // Unsaved means different from what the field showed for the saved text: opening a scene
  // and closing it again is never a change.
  const dirty = () => normalising || area.getValue() !== savedShown;
  unsavedEdit = dirty;

  function setEditable(editable) {
    area.setEditable(editable);
    mixedNote.hidden = editable;
    normalise.hidden = editable;
    saveButton.hidden = !editable;
  }
  // Shows a saved version of the scene in the field.
  function load(text, blob) {
    base = blob;
    endings = lineEndings(text);
    normalising = false;
    savedShown = shown(text);
    area.setValue(savedShown);
    setEditable(endings !== 'mixed');
  }
  load(scene.text, scene.blob);

  const draft = readDraft(book, file);
  if (draft) {
    // A draft is always stored with \n or \r\n only, so it is editable; when the scene itself
    // mixes endings, the draft was normalised and saving it still changes them.
    if (endings === 'mixed') {
      normalising = true;
      endings = 'lf';
      setEditable(true);
    }
    if (lineEndings(draft.text) === 'crlf') endings = 'crlf';
    base = draft.base_blob;
    area.setValue(shown(draft.text));
    status.textContent = draft.base_blob === scene.blob
      ? 'Se recuperó un texto sin guardar de esta pestaña.'
      : 'Se recuperó un texto sin guardar de esta pestaña, pero la escena cambió después: al guardar podrás comparar.';
  }

  function remember() {
    writeDraft(book, file, dirty() ? { base_blob: base, text: stored(area.getValue()) } : null);
    status.textContent = dirty() ? 'Cambios sin guardar' : 'Guardado';
    if (onText) onText();
  }

  const showConflict = (current) => {
    status.textContent = isNote
      ? 'No se guardó: la nota cambió mientras editabas. Tu versión sigue en el editor.'
      : 'No se guardó: la escena cambió mientras editabas. Tu versión sigue en el editor.';
    const useSaved = button('Usar la versión guardada', '', async () => {
      conflict.hidden = true;
      conflict.replaceChildren();
      load(current.text, current.blob);
      writeDraft(book, file, null);
      status.textContent = 'Se cargó la versión guardada. Tu versión se ha descartado.';
    });
    const keepMine = button('Guardar mi versión encima', 'accept', async () => {
      base = current.blob;
      conflict.hidden = true;
      conflict.replaceChildren();
      await save();
    });
    const row = el('div', undefined, 'form-row actions');
    row.append(useSaved, keepMine);
    conflict.replaceChildren(el('h4', 'La versión guardada ahora'), el('pre', current.text), row);
    conflict.hidden = false;
  };

  // One save at a time: a second Guardar or Ctrl+S while one is in flight would be based on
  // the old version and come back as a conflict with the person's own text.
  async function save() {
    if (saving || !area.isEditable() || !dirty()) return;
    saving = true;
    saveButton.disabled = true;
    const value = area.getValue();
    const wasNormalising = normalising;
    status.textContent = 'Guardando…';
    try {
      let result;
      try {
        result = await apiSave(docPath(book, file), { base_blob: base, text: stored(value) });
      } catch {
        status.textContent = 'Error: no se pudo conectar. Tu texto sigue aquí sin guardar.';
        return;
      }
      if (result.ok) {
        base = result.data.blob;
        savedShown = value;
        normalising = false;
        remember();
        if (!dirty() && wasNormalising) status.textContent = 'Guardado, con los finales de línea normalizados.';
        return;
      }
      if (result.status === 409 && result.data.current) return showConflict(result.data.current);
      status.textContent = 'Error: ' + (result.data.error || 'no se pudo guardar') + '. Tu texto sigue aquí sin guardar.';
    } finally {
      saving = false;
      saveButton.disabled = false;
    }
  }

  const closeEditor = button('Cerrar editor', '', async () => {
    if (dirty() && !window.confirm('Hay cambios sin guardar. ¿Cerrar el editor y descartarlos?')) return;
    writeDraft(book, file, null);
    unsavedEdit = null;
    area.destroy();
    await close();
  });
  const row = el('div', undefined, 'form-row actions');
  row.append(saveButton, closeEditor, status);
  // Guardar, the save state and the formatting toolbar stay together above the text, so the
  // desk can keep them in sight while the person writes (docs/design.md, "Scene editor").
  head = el('div', undefined, 'scene-head');
  head.append(row);
  if (area.toolbar) head.append(area.toolbar);
  box.append(mixedNote, normalise, head, area.dom, conflict);
  // What the writing desk needs from the editor; saving stays inside this function.
  box.editor = {
    file,
    dom: area.dom,
    getValue: () => area.getValue(),
    // The selected text, for Analizar; the plain field has one too.
    getSelection: () => (area.getSelection ? area.getSelection() : { from: 0, to: 0, text: '' }),
    // Where the caret is on screen ({ top, bottom }), or null, to keep it above the keyboard.
    caretRect: () => (area.caretRect ? area.caretRect() : null),
    head,
    select: (from, to) => area.select(from, to),
    setNotes: (notes) => { if (area.setNotes) area.setNotes(notes); },
    base: () => base,
    dirty,
    // Loads the saved version the person asked for, as "Usar la versión guardada" does.
    load(text, blob) {
      load(text, blob);
      writeDraft(book, file, null);
      remember();
    },
    destroy() {
      if (unsavedEdit === dirty) unsavedEdit = null;
      area.destroy();
    },
  };
  return box;
}

// Modes (issue #101, docs/design.md "Modes"). Concentración and Ayuda RE;write show the
// writing desk: one scene in the editor and, in Ayuda, the work waiting on that scene.
// Revisión is the full review page. The desk is built once and never re-rendered by a
// refresh or a decision, so switching modes keeps the text, the cursor and the selection.
const MODES = [['focus', 'Concentración'], ['help', 'Ayuda RE;write'], ['review', 'Revisión']];
let mode = 'review';
let lastWritingMode = 'focus';
let modeSwitch = null;
let desk = null;
// Opens a scene in the review's scene list (set by every render), for "Cerrar editor".
let showSceneInReview = null;

// The mode is kept in this browser under the same hash of the person as the editor view.
function modeKey() {
  return 'rewrite:mode:' + (personKey || '');
}
function readMode() {
  try {
    const saved = window.localStorage.getItem(modeKey());
    return MODES.some(([id]) => id === saved) ? saved : 'review';
  } catch {
    return 'review';
  }
}

function modeSwitchNode() {
  if (!modeSwitch) {
    const node = el('div', undefined, 'mode-switch');
    node.setAttribute('role', 'group');
    node.setAttribute('aria-label', 'Modo');
    const buttons = MODES.map(([id, label]) => {
      const choice = el('button', label);
      choice.type = 'button';
      choice.mode = id;
      // A tap on the switch leaves the focus, and so the caret, in the text; where the
      // browser moves it anyway, the switch gives it back.
      let caret = false;
      choice.addEventListener('pointerdown', () => { caret = Boolean(desk && desk.owns(document.activeElement)); });
      choice.addEventListener('mousedown', (event) => event.preventDefault());
      choice.addEventListener('click', () => {
        const options = { caret: caret || Boolean(desk && desk.owns(document.activeElement)) };
        caret = false;
        return setMode(id, options).catch((error) => showError(error.message));
      });
      return choice;
    });
    node.append(...buttons);
    modeSwitch = { node, buttons };
  }
  return modeSwitch.node;
}

// Shows a mode. options.file opens that scene in the desk (Editar escena), options.focus puts
// the caret in it, options.caret says the caret was in the text when the person switched.
async function setMode(next, options = {}) {
  mode = next;
  if (next !== 'review') lastWritingMode = next;
  try {
    window.localStorage.setItem(modeKey(), next);
  } catch {
    // No storage: the mode lasts while the page is open.
  }
  showMode(next);
  // Concentración never shows the assistant on its own; its button stays one tap away.
  if (next === 'focus' && assistant && typeof setAssistantOpen === 'function') setAssistantOpen(false, true);
  if (next === 'review') {
    // Hidden, the editor loses the focus; coming back gives the caret back where it was.
    if (desk) desk.resume = Boolean(options.caret);
    return;
  }
  const shown = ensureDesk();
  const resume = shown.resume || options.caret;
  shown.resume = false;
  await shown.show(options.file, options.focus);
  if (resume && !options.file) shown.focusEditor();
}

function ensureDesk() {
  if (!desk) {
    desk = createDesk();
    app.append(desk.node);
    watchKeyboard();
  }
  return desk;
}

// The mode the page shows, which is not always the one chosen: without a book there is no desk.
function showMode(shown) {
  if (document.body && document.body.setAttribute) document.body.setAttribute('data-mode', shown);
  if (modeSwitch) for (const choice of modeSwitch.buttons) choice.setAttribute('aria-pressed', String(choice.mode === shown));
  if (desk) desk.sync();
}

const deskSceneName = (file) => String(file).replace(/^scenes\//, '').replace(/\.md$/, '');
// Words as a writer counts them: letters and digits, with inner apostrophes and hyphens.
const wordCount = (text) => (text.match(/[\p{L}\p{N}]+(?:['’-][\p{L}\p{N}]+)*/gu) || []).length;
// The scene's title is its first heading; a scene without one is named by its file.
function sceneTitle(text, file) {
  const heading = /^#{1,6}[ \t]+(.+?)[ \t#]*$/m.exec(text);
  return heading ? heading[1] : deskSceneName(file);
}

// Where a quote is in the editor's text, which shows every line break as \n. A quote can
// appear more than once: the one nearest to where it was found wins.
function quoteRange(text, quote, near) {
  const wanted = String(quote || '').replace(/\r\n?/g, '\n');
  if (!wanted) return null;
  let best = -1;
  for (let at = text.indexOf(wanted); at !== -1; at = text.indexOf(wanted, at + 1)) {
    if (best === -1 || (typeof near === 'number' && Math.abs(at - near) < Math.abs(best - near))) best = at;
  }
  return best === -1 ? null : { from: best, to: best + wanted.length };
}

// The editor position of a 1-based line and column (UTF-16 units, as the server counts them) in
// the editor's text, where every line break is \n. null when the text has fewer lines.
function offsetAt(text, line, column) {
  let pos = 0;
  for (let n = 1; n < line; n += 1) {
    pos = text.indexOf('\n', pos) + 1;
    if (pos === 0) return null;
  }
  return Math.min(pos + column - 1, text.length);
}

// The note types of docs/notes-and-graph.md, as the Notas list groups them.
const NOTE_GROUPS = [['personaje', 'Personajes'], ['lugar', 'Lugares'], ['objeto', 'Objetos'], ['trama', 'Tramas'], ['otra', 'Otras']];
const NOTE_TYPES = { personaje: 'Personaje', lugar: 'Lugar', objeto: 'Objeto', trama: 'Trama', otra: 'Otra' };
const groupOf = (note) => (NOTE_TYPES[note.type] && note.type !== 'otra' ? note.type : 'otra');

function notesGroups(notes, onOpen) {
  if (!notes.length) return [el('p', 'Este libro aún no tiene notas. El asistente puede proponerlas y tú las aceptas en Revisión.', 'meta')];
  const out = [];
  for (const [type, label] of NOTE_GROUPS) {
    const group = notes.filter((note) => groupOf(note) === type);
    if (!group.length) continue;
    const section = el('section', undefined, 'notes-group');
    const list = el('ul', undefined, 'notes-list');
    for (const note of group) {
      const item = el('li');
      const open = el('button', note.name, 'note-open');
      open.type = 'button';
      open.addEventListener('click', () => onOpen(note.name));
      item.append(open);
      if (note.aliases && note.aliases.length) item.append(el('span', ' también: ' + note.aliases.join(', '), 'meta'));
      list.append(item);
    }
    section.append(el('h3', label + ' (' + group.length + ')'), list);
    out.push(section);
  }
  return out;
}

// One collator for every graph sort: localeCompare with a locale builds one per call.
const GRAPH_COLLATOR = new Intl.Collator('es');
const graphNodeName = (node) => (node.kind === 'scene' ? deskSceneName(node.name) : node.name);
const graphNodeType = (node) => (node.kind === 'scene' ? 'Escena' : NOTE_TYPES[node.type] || 'Sin tipo');
const countLabel = (n, one, many) => n.toLocaleString('es') + ' ' + (n === 1 ? one : many);

// How a neighbour is joined to the chosen node, in words.
function relationText(edge, selected) {
  if (edge.kind === 'link') return edge.from === selected ? 'la enlaza' : 'la enlaza a ella';
  if (edge.kind === 'cooccurs') return 'coinciden en ' + countLabel(edge.weight, 'escena', 'escenas');
  return edge.from === selected ? 'la menciona ' + countLabel(edge.weight, 'vez', 'veces') : 'aparece ' + countLabel(edge.weight, 'vez', 'veces');
}

// The note types the Grafo filters offer, with notes of no known type as their own group.
const GRAPH_TYPES = [['personaje', 'Personaje'], ['lugar', 'Lugar'], ['objeto', 'Objeto'], ['trama', 'Trama'], ['otra', 'Otra'], ['none', 'Sin tipo']];
const graphTypeKey = (node) => (NOTE_TYPES[node.type] ? node.type : 'none');
const GRAPH_VIEW_ERROR = 'No se pudo cargar el dibujo del grafo. La tabla tiene los mismos datos.';

// The Grafo drawing (editor/src/graph/), a chunk the editor module imports on demand. null when
// either is missing: the table works without it.
let graphViewModule = null;
function loadGraphViewModule() {
  if (!graphViewModule) {
    graphViewModule = loadEditorModule()
      .then((mod) => (mod && typeof mod.loadGraphView === 'function' ? mod.loadGraphView() : null))
      .then((mod) => (mod && typeof mod.createGraphView === 'function' ? mod : null))
      .catch(() => null)
      .then((mod) => {
        if (!mod) graphViewModule = null;
        return mod;
      });
  }
  return graphViewModule;
}

/**
 * The story graph (issue #115): a table of nodes sortable by its column headers, the neighbours
 * of the chosen node and, when "Dibujo" is on, the drawing with its "Análisis" panel. The table
 * never depends on the canvas, works from the keyboard (arrows move between nodes) and is what
 * phones start with; the drawing starts on wider screens. The filters (types, scenes, orphans,
 * "hasta la escena N") apply to both; the drawing can also be cut to the local graph (phones
 * start there). Choosing a node in either marks it in both
 * and is announced. onOpen(id) opens a note or a scene in the editor; current is the id of the
 * note or scene open in the desk, the centre of the local graph until a node is chosen. Returns
 * { node, select(id), destroy() }.
 */
function graphList(book, onOpen, current) {
  const box = el('div', undefined, 'graph-list');
  const phone = isPhone();
  const st = {
    data: null, sort: 'degree', desc: true, scenes: false, asOf: '', selected: null, rows: new Map(),
    types: new Set(GRAPH_TYPES.map(([key]) => key)), orphans: false, scope: phone ? 'local' : 'global', depth: 2,
    drawing: !phone, view: null, viewLoading: false, path: [], closed: false,
  };
  const check = (label, checked, onChange) => {
    const wrap = el('label');
    const input = el('input');
    input.type = 'checkbox';
    input.checked = checked;
    input.addEventListener('change', () => onChange(input.checked));
    wrap.append(input, document.createTextNode(' ' + label));
    return { wrap, input };
  };
  const controls = el('div', undefined, 'graph-controls');
  const drawingBox = check('Dibujo', st.drawing, (on) => {
    st.drawing = on;
    renderView();
  });
  const scopeLabel = el('label', 'Alcance ');
  const scope = el('select');
  for (const [key, label] of [['global', 'Grafo global'], ['local', 'Grafo local']]) {
    const option = el('option', label);
    option.value = key;
    scope.append(option);
  }
  scope.value = st.scope;
  scopeLabel.append(scope);
  const depthLabel = el('label', 'Profundidad ');
  const depth = el('input');
  depth.type = 'range';
  depth.min = '1';
  depth.max = '3';
  depth.step = '1';
  depth.value = String(st.depth);
  const depthOut = el('output', String(st.depth));
  depthLabel.append(depth, depthOut);
  const scenesBox = check('Mostrar escenas', false, (on) => {
    st.scenes = on;
    refresh();
  });
  const orphansBox = check('Solo huérfanas', false, (on) => {
    st.orphans = on;
    refresh();
  });
  const types = el('fieldset', undefined, 'graph-types');
  types.append(el('legend', 'Tipos'));
  const typeBoxes = new Map();
  for (const [key, label] of GRAPH_TYPES) {
    const one = check(label, true, (on) => {
      if (on) st.types.add(key);
      else st.types.delete(key);
      refresh();
    });
    typeBoxes.set(key, one.input);
    types.append(one.wrap);
  }
  const asOfLabel = el('label', 'Hasta la escena ', 'graph-asof');
  const asOf = el('input');
  asOf.type = 'range';
  asOf.min = '1';
  asOf.step = '1';
  const asOfOut = el('output');
  asOfLabel.append(asOf, asOfOut);
  asOfLabel.hidden = true;
  controls.append(drawingBox.wrap, scopeLabel, depthLabel, scenesBox.wrap, orphansBox.wrap, asOfLabel, types);
  const live = el('p', '', 'meta graph-live');
  live.setAttribute('role', 'status');
  const viewBox = el('div', undefined, 'graph-view-box');
  const table = el('table', undefined, 'graph-table');
  const thead = el('thead');
  const headRow = el('tr');
  const COLUMNS = [['name', 'Nodo'], ['type', 'Tipo'], ['degree', 'Grado'], ['scenes', 'Escenas']];
  const heads = COLUMNS.map(([key, label]) => {
    const th = el('th');
    th.setAttribute('scope', 'col');
    const sort = el('button', label, 'graph-sort');
    sort.type = 'button';
    sort.addEventListener('click', () => {
      if (st.sort === key) st.desc = !st.desc;
      else {
        st.sort = key;
        st.desc = key === 'degree' || key === 'scenes';
      }
      renderRows();
    });
    th.append(sort);
    return { key, th };
  });
  headRow.append(...heads.map((head) => head.th));
  thead.append(headRow);
  const tbody = el('tbody');
  table.append(el('caption', 'Nodos del grafo'), thead, tbody);
  const detail = el('section', undefined, 'graph-detail');
  detail.setAttribute('aria-label', 'Vecinos del nodo elegido');
  detail.hidden = true;
  box.append(el('p', 'Cada nota del libro con sus conexiones. El grado cuenta las notas y escenas distintas con las que conecta; Escenas, las escenas que la mencionan. Elige un nodo, en la tabla o en el dibujo, para ver sus vecinos.', 'meta'),
    controls, live, viewBox, table, detail);

  const nodeById = () => new Map(st.data.nodes.map((node) => [node.id, node]));
  // The centre of the local graph: the chosen node, else the note or scene open in the desk.
  const centre = () => {
    const byId = nodeById();
    return [st.selected, current].find((id) => id && byId.has(id)) || null;
  };
  const passes = (node) => (node.kind === 'scene' ? st.scenes : st.types.has(graphTypeKey(node))) && (!st.orphans || node.degree === 0);
  // The nodes the drawing shows: the table's filters, then the local cut (the centre always stays).
  function visibleNodes() {
    const nodes = st.data.nodes.filter(passes);
    const middle = st.scope === 'local' ? centre() : null;
    if (!middle) return nodes;
    const allowed = new Set(nodes.map((node) => node.id));
    allowed.add(middle);
    const near = new Map();
    for (const edge of st.data.edges) {
      if (!allowed.has(edge.from) || !allowed.has(edge.to)) continue;
      if (!near.has(edge.from)) near.set(edge.from, []);
      if (!near.has(edge.to)) near.set(edge.to, []);
      near.get(edge.from).push(edge.to);
      near.get(edge.to).push(edge.from);
    }
    const within = new Set([middle]);
    let ring = [middle];
    for (let step = 0; step < st.depth && ring.length; step++) {
      const next = [];
      for (const id of ring) for (const other of near.get(id) || []) if (!within.has(other)) {
        within.add(other);
        next.push(other);
      }
      ring = next;
    }
    return st.data.nodes.filter((node) => within.has(node.id));
  }
  const shown = (node) => st.scenes || node.kind !== 'scene';
  function compare(a, b) {
    const name = GRAPH_COLLATOR.compare(graphNodeName(a), graphNodeName(b));
    let by = 0;
    if (st.sort === 'name') by = name;
    else if (st.sort === 'type') by = GRAPH_COLLATOR.compare(graphNodeType(a), graphNodeType(b));
    else if (st.sort === 'degree') by = a.degree - b.degree;
    else by = (a.scenes === null ? -1 : a.scenes) - (b.scenes === null ? -1 : b.scenes);
    return (st.desc ? -by : by) || name;
  }

  function renderRows() {
    for (const head of heads) head.th.setAttribute('aria-sort', head.key === st.sort ? (st.desc ? 'descending' : 'ascending') : 'none');
    st.rows = new Map();
    const onPath = new Set(st.path);
    const nodes = st.data.nodes.filter(passes).sort(compare);
    tbody.replaceChildren(...nodes.map((node) => {
      const row = el('tr');
      const cell = el('td');
      const pick = el('button', graphNodeName(node), 'graph-node');
      pick.type = 'button';
      pick.setAttribute('aria-pressed', String(node.id === st.selected));
      pick.addEventListener('click', () => select(node.id));
      cell.append(pick);
      row.append(cell, el('td', graphNodeType(node)), el('td', String(node.degree)), el('td', node.scenes === null ? '—' : String(node.scenes)));
      row.className = [node.id === st.selected ? 'selected' : '', onPath.has(node.id) ? 'on-path' : ''].join(' ').trim();
      st.rows.set(node.id, { row, pick });
      return row;
    }));
    if (!nodes.length) {
      const row = el('tr');
      const cell = el('td', st.data.nodes.length ? 'Ningún nodo pasa estos filtros.' : 'Este libro aún no tiene notas.');
      cell.setAttribute('colspan', '4');
      row.append(cell);
      tbody.replaceChildren(row);
    }
  }

  function markRow(id, on) {
    const entry = id && st.rows.get(id);
    if (!entry) return;
    entry.pick.setAttribute('aria-pressed', String(on));
    entry.row.classList.toggle('selected', on);
  }

  // Up and Down move between the nodes of the table, Home and End to the first and the last.
  tbody.addEventListener('keydown', (event) => {
    const buttons = Array.from(tbody.getElementsByTagName('button'));
    const at = buttons.indexOf(document.activeElement);
    if (at === -1) return;
    const next = { ArrowDown: buttons[at + 1], ArrowUp: buttons[at - 1], Home: buttons[0], End: buttons[buttons.length - 1] }[event.key];
    if (!next) return;
    event.preventDefault();
    next.focus();
  });

  function renderDetail() {
    const byId = nodeById();
    const node = byId.get(st.selected);
    if (!node) {
      detail.hidden = true;
      detail.replaceChildren();
      return;
    }
    const joined = new Map();
    for (const edge of st.data.edges) {
      const other = edge.from === node.id ? edge.to : edge.to === node.id ? edge.from : null;
      if (other === null) continue;
      if (!joined.has(other)) joined.set(other, []);
      joined.get(other).push(relationText(edge, node.id));
    }
    const neighbours = [...joined.keys()].map((id) => byId.get(id)).filter(Boolean);
    const visible = neighbours.filter(shown).sort((a, b) => b.degree - a.degree || GRAPH_COLLATOR.compare(graphNodeName(a), graphNodeName(b)));
    const hiddenScenes = neighbours.length - visible.length;
    const openIt = el('button', 'Abrir ' + graphNodeName(node));
    openIt.type = 'button';
    openIt.addEventListener('click', () => onOpen(node.id));
    const list = el('ul', undefined, 'graph-neighbours');
    for (const other of visible) {
      const item = el('li');
      const pick = el('button', graphNodeName(other), 'graph-neighbour');
      pick.type = 'button';
      pick.addEventListener('click', () => select(other.id, true));
      item.append(pick, el('span', ' ' + graphNodeType(other) + ' · ' + joined.get(other.id).join(', '), 'meta'));
      list.append(item);
    }
    const children = [el('h3', 'Vecinos de ' + graphNodeName(node) + ' (' + neighbours.length + ')'), openIt];
    children.push(visible.length ? list : el('p', neighbours.length ? '' : 'No conecta con ninguna nota ni escena.', 'meta'));
    if (hiddenScenes) children.push(el('p', 'Y ' + countLabel(hiddenScenes, 'escena oculta', 'escenas ocultas') + ' (marca «Mostrar escenas»).', 'meta'));
    detail.replaceChildren(...children);
    detail.hidden = false;
  }

  // The drawing: its chunk is fetched the first time "Dibujo" is on, never before.
  async function renderView() {
    scopeLabel.hidden = !st.drawing;
    depthLabel.hidden = !st.drawing || st.scope !== 'local';
    if (!st.drawing) {
      viewBox.hidden = true;
      return;
    }
    viewBox.hidden = false;
    if (!st.data) return;
    if (!st.view) {
      if (st.viewLoading) return;
      st.viewLoading = true;
      viewBox.replaceChildren(el('p', 'Cargando el dibujo…', 'meta'));
      const mod = await loadGraphViewModule();
      st.viewLoading = false;
      if (st.closed) return;
      if (!mod) {
        viewBox.replaceChildren(el('p', GRAPH_VIEW_ERROR, 'meta graph-view-error'));
        return;
      }
      st.view = mod.createGraphView({
        book,
        onSelect: (id) => select(id),
        onPath: (ids) => {
          st.path = ids;
          renderRows();
        },
        announce: (text) => (live.textContent = text),
      });
      viewBox.replaceChildren(st.view.node);
    }
    const nodes = visibleNodes();
    const ids = new Set(nodes.map((node) => node.id));
    st.view.show({
      nodes: nodes.map((node) => ({ ...node, label: graphNodeName(node) })),
      edges: st.data.edges.filter((edge) => ids.has(edge.from) && ids.has(edge.to)),
    }, { selected: st.selected });
    st.view.select(st.selected);
  }

  function refresh() {
    renderRows();
    renderDetail();
    renderView();
  }

  // Makes a node visible again when a filter hides it, so a choice always shows. Says whether a
  // filter changed.
  function reveal(node) {
    let changed = false;
    if (node.kind === 'scene' && !st.scenes) {
      st.scenes = true;
      scenesBox.input.checked = true;
      changed = true;
    }
    if (node.kind === 'note' && !st.types.has(graphTypeKey(node))) {
      st.types.add(graphTypeKey(node));
      typeBoxes.get(graphTypeKey(node)).checked = true;
      changed = true;
    }
    if (st.orphans && node.degree !== 0) {
      st.orphans = false;
      orphansBox.input.checked = false;
      changed = true;
    }
    return changed;
  }

  // Chooses a node: its row is marked, its neighbours listed, the drawing marks it, and the
  // choice is announced. In the local graph the chosen node becomes the centre, so the drawing
  // is cut again; otherwise only the marks change.
  function select(id, focusRow) {
    const node = st.data && nodeById().get(id);
    if (!node) return;
    const changed = reveal(node);
    const previous = st.selected;
    st.selected = id;
    if (changed || (st.drawing && st.scope === 'local')) refresh();
    else {
      // Only the two rows whose mark changes are touched, so a large table answers at once.
      markRow(previous, false);
      markRow(id, true);
      renderDetail();
      // The drawing follows a frame later, so the table answers first on a slow machine.
      if (st.view) requestAnimationFrame(() => setTimeout(() => st.view && st.view.select(st.selected), 0));
    }
    live.textContent = 'Elegido: ' + graphNodeName(node) + ', ' + graphNodeType(node).toLowerCase() + ', grado ' + node.degree + '.';
    const row = st.rows.get(id);
    if (focusRow && row) row.pick.focus();
  }

  function showAsOf() {
    const total = st.data.scenes.length;
    const at = st.asOf ? st.data.scenes.indexOf(st.asOf) + 1 : total;
    const text = at + ' de ' + total + ': ' + (total ? deskSceneName(st.data.scenes[at - 1]) : '');
    asOfOut.textContent = text;
    asOf.setAttribute('aria-valuetext', text);
  }

  async function load() {
    live.textContent = 'Cargando el grafo…';
    let data;
    try {
      data = await api('/books/' + book + '/graph' + (st.asOf ? '?as_of_scene=' + encodeURIComponent(st.asOf) : ''));
    } catch (error) {
      live.textContent = error.message;
      return;
    }
    if (st.closed) return;
    st.data = data;
    if (asOfLabel.hidden && data.scenes.length) {
      asOf.max = String(data.scenes.length);
      asOf.value = asOf.max;
      asOfLabel.hidden = false;
    }
    showAsOf();
    const notes = data.nodes.filter((node) => node.kind === 'note').length;
    live.textContent = countLabel(notes, 'nota', 'notas') + ' y ' + countLabel(data.nodes.length - notes, 'escena', 'escenas') + (st.asOf ? ' hasta ' + deskSceneName(st.asOf) : '') + '.';
    refresh();
  }
  scope.addEventListener('change', () => {
    st.scope = scope.value;
    refresh();
  });
  depth.addEventListener('input', () => {
    st.depth = Number(depth.value);
    depthOut.textContent = depth.value;
    refresh();
  });
  // The slider says where it is while it moves, and asks for the graph when it stops.
  asOf.addEventListener('input', () => {
    if (!st.data) return;
    const n = Number(asOf.value);
    st.asOf = n >= st.data.scenes.length ? '' : st.data.scenes[n - 1];
    showAsOf();
  });
  asOf.addEventListener('change', () => load());
  scopeLabel.hidden = !st.drawing;
  depthLabel.hidden = !st.drawing || st.scope !== 'local';
  viewBox.hidden = !st.drawing;
  load();
  return {
    node: box,
    select,
    destroy() {
      st.closed = true;
      if (st.view) st.view.destroy();
      st.view = null;
    },
  };
}

// Analizar (issue #101): what the assistant is asked, by scope. The scene is read by the
// assistant from the saved version; a selection travels inside the prompt, as typed.
const ANALYSE_FOCUS = 'Fíjate en las motivaciones, las consecuencias y lo que sabe cada personaje. Distingue hechos, interpretaciones e ideas alternativas, y cita el texto.';
const ANALYSE_PROMPTS = {
  scene: 'Analiza esta escena. ' + ANALYSE_FOCUS,
  selection: 'Analiza este fragmento. ' + ANALYSE_FOCUS,
  book: 'Analiza el libro entero. ' + ANALYSE_FOCUS + ' Di qué escenas has leído: un análisis parcial no representa el libro.',
};
// The server refuses a prompt longer than this (MAX_PROMPT in http-server.ts).
const ANALYSE_MAX = 8000;
const SCOPES = [['scene', 'Esta escena'], ['selection', 'La selección'], ['book', 'El libro']];
// "1.240 palabras", grouped as the scope line of the issue shows it.
const groupedCount = (n, one, many) => new Intl.NumberFormat('es', { useGrouping: 'always' }).format(n) + ' ' + (n === 1 ? one : many);
// "scenes/003-el-faro.md" reads "escena 3", as the assistant panel names scenes.
function sceneLabel(file) {
  const name = deskSceneName(file);
  const numbered = /^(\d{1,4})(?:[-_ ]|$)/.exec(name);
  return numbered ? 'escena ' + Number(numbered[1]) : name.replace(/[-_]+/g, ' ');
}

// Sends an analysis through the assistant panel of src/adapters/engine-page.ts (the same
// script, so its functions are in scope): the item becomes the panel's reference and the turn
// carries the usual page context. Returns 'sent', 'connect' (ChatGPT is not connected: the
// panel shows how, with the prompt already written) or 'busy'.
async function analyseWithAssistant(item, prompt, opener) {
  setAssistantItem(item);
  openAssistant(opener);
  await refreshAssistantStatus().catch(() => {});
  if (assistantState.status.state !== 'connected') {
    panel.input.value = prompt;
    fitInput();
    return 'connect';
  }
  if (assistantState.running) return 'busy';
  // The answer streams into the panel; the desk only says it went.
  sendAssistant(prompt).catch(() => {});
  return 'sent';
}

// What covers the window above and below the editor's text: the sticky head of the editor and,
// with a phone keyboard open, the part of the window the visual viewport no longer shows; below,
// also the bottom dock while it is shown. In px, from the window's edges.
function editorMargins(head) {
  const vv = window.visualViewport;
  const offset = vv ? vv.offsetTop : 0;
  let top = offset + (head && head.getBoundingClientRect ? head.getBoundingClientRect().height : 0);
  let bottom = vv ? Math.max(0, window.innerHeight - offset - vv.height) : 0;
  const dock = modeSwitch && modeSwitch.node;
  if (dock && dock.getBoundingClientRect && window.getComputedStyle) {
    const style = window.getComputedStyle(dock);
    if (style.position === 'fixed' && style.display !== 'none') bottom += dock.getBoundingClientRect().height;
  }
  return { top, bottom };
}

// Phones (docs/design.md, "Modes"): with the on-screen keyboard open the visual viewport is
// shorter than the window. The body gets .keyboard-open (the dock and the floating button give
// way), --vv-top keeps the editor's sticky head at the top of what is visible, and the caret is
// scrolled back above the keyboard. A keyboard is a visual viewport under 75% of the tallest
// seen at that width while the text has the focus.
function watchKeyboard() {
  const vv = window.visualViewport;
  if (!vv || !vv.addEventListener || !document.documentElement) return;
  let tallest = { width: 0, height: 0 };
  const update = (event) => {
    if (vv.width !== tallest.width) tallest = { width: vv.width, height: 0 };
    tallest.height = Math.max(tallest.height, vv.height);
    const typing = Boolean(desk && desk.owns(document.activeElement));
    const open = typing && vv.height < tallest.height * 0.75;
    document.body.classList.toggle('keyboard-open', open);
    document.documentElement.style.setProperty('--vv-top', open ? Math.max(0, vv.offsetTop) + 'px' : '0px');
    // Only the keyboard resizing the screen moves the page: following its own scroll, or any
    // other resize (a scrollbar appearing on a desktop), would fight the person.
    if (open && event && event.type === 'resize') desk.keepCaretVisible();
  };
  vv.addEventListener('resize', update);
  vv.addEventListener('scroll', update);
  document.addEventListener('focusin', () => update());
  document.addEventListener('focusout', () => setTimeout(() => update(), 0));
}

function createDesk() {
  const node = el('section', undefined, 'desk');
  node.id = 'desk';
  node.setAttribute('aria-label', 'Escritura');
  const head = el('div', undefined, 'desk-head');
  const scenes = el('div', undefined, 'desk-scenes');
  // On a phone only the arrows show; the words stay for wider screens and for the name.
  const prev = el('button', '‹');
  prev.type = 'button';
  prev.append(el('span', ' Anterior'));
  prev.setAttribute('aria-label', 'Escena anterior');
  const next = el('button');
  next.type = 'button';
  next.append(el('span', 'Siguiente '), document.createTextNode('›'));
  next.setAttribute('aria-label', 'Escena siguiente');
  const picker = el('select');
  picker.setAttribute('aria-label', 'Escena');
  scenes.append(prev, picker, next);
  const title = el('h2', '', 'desk-title');
  const words = el('p', '', 'meta desk-count');
  // Notas and Grafo (issue #115): the book's notes and its story graph, shown over the text,
  // which stays in its editor behind them.
  const tools = el('div', undefined, 'desk-tools');
  tools.setAttribute('role', 'group');
  tools.setAttribute('aria-label', 'Notas y grafo del libro');
  const notesTool = el('button', 'Notas');
  notesTool.type = 'button';
  const graphTool = el('button', 'Grafo');
  graphTool.type = 'button';
  for (const tool of [notesTool, graphTool]) {
    tool.setAttribute('aria-expanded', 'false');
    tool.setAttribute('aria-controls', 'desk-panel');
  }
  tools.append(notesTool, graphTool);
  // Analizar, in Ayuda only: the scope is chosen and shown before anything is sent.
  const analyseTool = el('button', 'Analizar', 'analyse-toggle');
  analyseTool.type = 'button';
  analyseTool.setAttribute('aria-expanded', 'false');
  analyseTool.setAttribute('aria-controls', 'desk-analyse');
  const deskStatus = el('p', '', 'meta desk-status');
  deskStatus.setAttribute('role', 'status');
  head.append(scenes, tools, analyseTool, title, words, deskStatus);
  const analyse = el('section', undefined, 'desk-analyse');
  analyse.id = 'desk-analyse';
  analyse.setAttribute('aria-label', 'Analizar');
  analyse.hidden = true;
  const scopeGroup = el('div', undefined, 'analyse-scopes');
  scopeGroup.setAttribute('role', 'group');
  scopeGroup.setAttribute('aria-label', 'Qué analizar');
  const scopeButtons = SCOPES.map(([id, label]) => {
    const choice = el('button', label);
    choice.type = 'button';
    choice.scope = id;
    // The selection it may analyse stays in the text while the person picks.
    choice.addEventListener('mousedown', (event) => event.preventDefault());
    choice.addEventListener('click', () => {
      state.scope = id;
      renderAnalyse();
    });
    return choice;
  });
  scopeGroup.append(...scopeButtons);
  const scopeLine = el('p', '', 'analyse-scope');
  scopeLine.setAttribute('role', 'status');
  const scopeNote = el('p', '', 'meta analyse-hint');
  const sendAnalyse = el('button', 'Enviar al asistente', 'accept');
  sendAnalyse.type = 'button';
  sendAnalyse.addEventListener('mousedown', (event) => event.preventDefault());
  const analyseStatus = el('p', '', 'meta analyse-status');
  analyseStatus.setAttribute('role', 'status');
  analyse.append(el('h2', 'Analizar'), scopeGroup, scopeLine, scopeNote, sendAnalyse, analyseStatus);
  const panel = el('section', undefined, 'desk-panel');
  panel.id = 'desk-panel';
  panel.hidden = true;
  // Said when the open scene was saved somewhere else; the editor itself is never touched.
  const banner = el('div', undefined, 'desk-banner');
  const bannerText = el('p');
  bannerText.setAttribute('role', 'status');
  const bannerLoad = el('button', 'Cargar la versión guardada');
  bannerLoad.type = 'button';
  banner.append(bannerText, bannerLoad);
  banner.hidden = true;
  // Phones: the text and the help are two panes, one tap apart.
  const panes = el('div', undefined, 'desk-panes');
  panes.setAttribute('role', 'group');
  panes.setAttribute('aria-label', 'Panel');
  const textPane = el('button', 'Texto');
  textPane.type = 'button';
  const helpPane = el('button', 'Ayuda');
  helpPane.type = 'button';
  panes.append(textPane, helpPane);
  const bodyBox = el('div', undefined, 'desk-body');
  const slot = el('div', undefined, 'desk-editor');
  const help = el('aside', undefined, 'desk-help');
  help.setAttribute('aria-label', 'Ayuda para esta escena');
  bodyBox.append(slot, help);
  node.append(head, analyse, banner, panes, panel, bodyBox);

  const state = { book: null, file: null, scenes: [], editor: null, saved: null, pane: 'text', opening: 0, statsQueued: false, notes: null, lib: null, panel: null, scope: 'scene' };

  // What Analizar would send for a scope: the line that names it, the panel's item and the
  // prompt; or the reason it cannot (why). Never anything the assistant cannot really do.
  function analysisPlan(scope) {
    const file = state.file;
    const editor = state.editor;
    const isNote = Boolean(file) && isNoteFile(file);
    const where = isNote ? 'la nota ' + noteName(file) : file ? sceneLabel(file) : '';
    const item = file && !isNote ? { kind: 'scene', id: file, label: 'Escena: ' + deskSceneName(file) } : null;
    if (scope === 'book') {
      const title = currentBookTitle ? ' «' + currentBookTitle + '»' : '';
      return { line: 'Se analizará: el libro' + title + ' (' + groupedCount(state.scenes.length, 'escena', 'escenas') + ')', item: null, prompt: ANALYSE_PROMPTS.book,
        hint: 'El asistente lee las escenas guardadas y dirá cuáles ha leído: un análisis parcial no representa el libro entero.' };
    }
    if (!editor) return { why: 'Abre una escena para analizarla.' };
    if (scope === 'scene') {
      if (isNote) return { why: 'Una nota no es una escena: analiza la selección o el libro.' };
      return { line: 'Se analizará: ' + where + ' (' + groupedCount(wordCount(editor.getValue()), 'palabra', 'palabras') + ')', item, prompt: ANALYSE_PROMPTS.scene,
        hint: editor.dirty() ? 'El asistente lee la versión guardada: tus cambios sin guardar no entran. Guarda antes si quieres que los lea.' : 'El asistente lee la versión guardada de la escena.' };
    }
    const selected = editor.getSelection();
    if (!selected.text.trim()) return { why: 'Selecciona un fragmento en el texto para analizarlo.' };
    const quoted = selected.text.split('\n').map((line) => '> ' + line).join('\n');
    const prompt = ANALYSE_PROMPTS.selection + (where ? ' Es de ' + where + '.' : '') + '\n\n' + quoted;
    if (prompt.length > ANALYSE_MAX) return { why: 'La selección es demasiado larga para enviarla. Selecciona menos texto o analiza la escena entera.' };
    return { line: 'Se analizará: la selección de ' + where + ' (' + groupedCount(wordCount(selected.text), 'palabra', 'palabras') + ')', item, prompt,
      hint: 'El fragmento se envía tal como está en el editor, aunque no lo hayas guardado.' };
  }

  function renderAnalyse() {
    const shown = mode === 'help' && !analyse.hidden;
    analyseTool.setAttribute('aria-expanded', String(shown));
    if (!shown) return;
    for (const choice of scopeButtons) choice.setAttribute('aria-pressed', String(choice.scope === state.scope));
    const plan = analysisPlan(state.scope);
    scopeLine.textContent = plan.line || plan.why;
    scopeNote.textContent = plan.hint || '';
    sendAnalyse.disabled = !plan.prompt;
  }

  function setAnalyseOpen(open) {
    analyse.hidden = !open;
    analyseStatus.textContent = '';
    renderAnalyse();
  }
  analyseTool.addEventListener('mousedown', (event) => event.preventDefault());
  analyseTool.addEventListener('click', () => setAnalyseOpen(analyse.hidden));
  // The selection can change while the box is open: it is read again when the person comes back.
  analyse.addEventListener('focusin', () => renderAnalyse());
  analyse.addEventListener('pointerenter', () => renderAnalyse());

  sendAnalyse.addEventListener('click', async () => {
    const plan = analysisPlan(state.scope);
    renderAnalyse();
    if (!plan.prompt) return;
    if (!assistant || typeof analyseWithAssistant !== 'function' || typeof sendAssistant !== 'function') {
      analyseStatus.textContent = 'El asistente no está activado en este servidor. Tu cuenta de RE;write basta para escribir y revisar; también puedes analizar el libro desde tu propio ChatGPT con el conector de RE;write.';
      return;
    }
    const outcome = await analyseWithAssistant(plan.item, plan.prompt, sendAnalyse);
    analyseStatus.textContent = outcome === 'sent'
      ? 'Enviado al asistente. La respuesta aparece en su panel.'
      : outcome === 'busy'
        ? 'Ya hay una respuesta en curso. Espera a que termine o detenla.'
        : 'Para analizar, conecta tu propia cuenta de ChatGPT en el panel del asistente; el mensaje queda escrito para enviarlo después. Nunca escribas tu contraseña en RE;write.';
  });

  const sceneKey = (book) => 'rewrite:desk-scene:' + (personKey || '') + ':' + book;
  function rememberScene(book, file) {
    try {
      window.localStorage.setItem(sceneKey(book), file);
    } catch {}
  }
  function rememberedScene(book) {
    try {
      return window.localStorage.getItem(sceneKey(book));
    } catch {
      return null;
    }
  }

  function setPane(pane) {
    state.pane = mode === 'help' ? pane : 'text';
    node.setAttribute('data-pane', state.pane);
    textPane.setAttribute('aria-pressed', String(state.pane === 'text'));
    helpPane.setAttribute('aria-pressed', String(state.pane === 'help'));
  }
  textPane.addEventListener('click', () => setPane('text'));
  helpPane.addEventListener('click', () => setPane('help'));

  function fillPicker() {
    const options = state.scenes.map((file) => {
      const option = el('option', deskSceneName(file));
      option.value = file;
      option.selected = file === state.file;
      return option;
    });
    // With a note open the picker names it, and choosing a scene goes back to the scenes.
    if (isNoteFile(state.file)) {
      const current = el('option', 'Nota: ' + noteName(state.file));
      current.value = '';
      current.selected = true;
      current.disabled = true;
      options.unshift(current);
    }
    picker.replaceChildren(...options);
    const at = state.scenes.indexOf(state.file);
    prev.disabled = at <= 0;
    next.disabled = at === -1 || at >= state.scenes.length - 1;
  }
  const step = (by) => () => {
    const at = state.scenes.indexOf(state.file) + by;
    if (at < 0 || at >= state.scenes.length) return undefined;
    return open(state.scenes[at], false).catch((error) => showError(error.message));
  };
  prev.addEventListener('click', step(-1));
  next.addEventListener('click', step(1));
  picker.addEventListener('change', () => open(picker.value, false).catch((error) => showError(error.message)));

  function updateStats() {
    state.statsQueued = false;
    if (!state.editor) return;
    const text = state.editor.getValue();
    title.textContent = isNoteFile(state.file) ? noteName(state.file) : sceneTitle(text, state.file);
    const count = wordCount(text);
    words.textContent = count.toLocaleString('es') + (count === 1 ? ' palabra' : ' palabras');
    showBanner();
    renderAnalyse();
  }
  // Counting reads the whole text: at most once per pause in the typing.
  function queueStats() {
    if (state.statsQueued) return;
    state.statsQueued = true;
    setTimeout(updateStats, 150);
  }

  function showBanner() {
    const editor = state.editor;
    const changed = Boolean(editor && state.saved && state.saved.blob !== editor.base());
    banner.hidden = !changed;
    if (!changed) return;
    const dirty = editor.dirty();
    bannerText.textContent = 'Esta escena ha cambiado fuera de este editor. ' + (dirty
      ? 'Tu texto sigue aquí sin guardar: al guardar podrás comparar las dos versiones.'
      : 'Puedes cargar la versión guardada; no tienes cambios sin guardar.');
    bannerLoad.hidden = dirty;
  }
  bannerLoad.addEventListener('click', () => {
    if (!state.editor || !state.saved || state.editor.dirty()) return;
    state.editor.load(state.saved.text, state.saved.blob);
    showBanner();
  });

  function dropEditor() {
    if (state.editor) state.editor.destroy();
    state.editor = null;
    state.saved = null;
    banner.hidden = true;
  }

  // The book's notes ({ name, type, aliases }), asked for again each time they are needed, so a
  // note accepted meanwhile resolves.
  async function loadNotes() {
    const book = state.book;
    const data = await api('/books/' + book + '/notes');
    if (book !== state.book) return state.notes || [];
    state.notes = data.notes;
    if (state.editor) state.editor.setNotes(state.notes);
    return state.notes;
  }

  // A followed wikilink: the note it names, resolved by the server's rules (the editor module's
  // noteIndex); a link that names no note, or more than one, says so instead.
  function followLink(target) {
    const lib = state.lib;
    const found = lib && lib.noteIndex ? lib.noteIndex(state.notes || []).resolve(target) : { status: 'unresolved' };
    if (found.status === 'resolved') {
      deskStatus.textContent = '';
      return open(noteFile(found.note), true).catch((error) => showError(error.message));
    }
    deskStatus.textContent = found.status === 'ambiguous'
      ? '«' + target + '» puede ser más de una nota: ' + found.candidates.join(', ') + '.'
      : 'Ninguna nota se llama «' + target + '». El asistente puede proponerla.';
    return undefined;
  }

  // Opens a scene or a note in the editor. Unsaved text of the one left behind stays as its draft.
  // at ({ line, column, length }, 1-based like the server's mentions) selects that text.
  async function open(file, focus, at) {
    const seq = ++state.opening;
    const book = state.book;
    const isNote = isNoteFile(file);
    dropEditor();
    if (state.panel) setPanel(null);
    state.file = file;
    if (!isNote) rememberScene(book, file);
    fillPicker();
    title.textContent = isNote ? noteName(file) : deskSceneName(file);
    words.textContent = '';
    deskStatus.textContent = '';
    slot.replaceChildren(el('p', isNote ? 'Cargando nota…' : 'Cargando escena…', 'meta'));
    let data;
    try {
      data = await api(docPath(book, file));
    } catch (error) {
      if (seq === state.opening) slot.replaceChildren(el('p', error.message, 'meta'));
      return;
    }
    const lib = await loadEditorModule();
    // Without the editor module there are no links to resolve.
    if (lib) await loadNotes().catch(() => {});
    if (seq !== state.opening || book !== state.book) return;
    state.lib = lib;
    // Following a link replaces this editor, so it waits until the editor's own event is over.
    const links = { notes: state.notes || [], onOpenNote: (target) => setTimeout(() => followLink(target), 0) };
    const box = sceneEditor(book, data, () => closed(book, file), lib, queueStats, links);
    state.box = box;
    state.editor = box.editor;
    state.saved = { blob: data.blob, text: data.text };
    slot.replaceChildren(box);
    if (isNote && data.backlinks) slot.append(backlinksNode(data));
    updateStats();
    renderHelp();
    const from = at ? offsetAt(state.editor.getValue(), at.line, at.column) : null;
    if (from !== null) state.editor.select(from, from + at.length);
    else if (focus) box.focusEditor();
  }

  // "Cerrar editor": back to the review, at the scene that was open.
  async function closed(book, file) {
    state.editor = null;
    state.file = null;
    slot.replaceChildren();
    await setMode('review');
    if (!isNoteFile(file) && showSceneInReview && book === selectedBook) await showSceneInReview(file);
  }

  // A note's backlinks: where it is linked, with the sentence, and where its name or an alias
  // appears without a link. Each one opens that scene or note with the mention selected.
  function backlinksNode(note) {
    const box = el('section', undefined, 'note-backlinks');
    box.setAttribute('aria-label', 'Menciones de ' + note.name);
    const found = note.backlinks;
    box.append(el('h3', 'Menciones enlazadas (' + found.linked_total + ')'),
      mentionList(found.linked, (m) => m.raw, 'Nada enlaza esta nota todavía.'));
    box.append(el('h3', 'Menciones sin enlazar (' + found.unlinked_total + ')'),
      mentionList(found.unlinked, (m) => m.text, 'Su nombre no aparece sin enlace.'));
    if (found.linked.length < found.linked_total || found.unlinked.length < found.unlinked_total) {
      box.append(el('p', 'Se muestran las primeras ' + found.linked.length.toLocaleString('es') + ' de cada tipo.', 'meta'));
    }
    return box;
  }
  function mentionList(mentions, textOf, empty) {
    if (!mentions.length) return el('p', empty, 'meta');
    const list = el('ul', undefined, 'mentions');
    for (const mention of mentions) {
      const where = mention.source_kind === 'scene' ? deskSceneName(mention.source) : mention.source;
      const target = mention.source_kind === 'scene' ? mention.source : noteFile(mention.source);
      const item = el('li');
      const go = el('button', where + ', línea ' + mention.line, 'mention-source');
      go.type = 'button';
      go.setAttribute('aria-label', 'Ir a la mención en ' + where + ', línea ' + mention.line);
      go.addEventListener('click', () => open(target, true, { line: mention.line, column: mention.column, length: textOf(mention).length })
        .catch((error) => showError(error.message)));
      item.append(go, el('p', mention.context, 'mention-context'));
      list.append(item);
    }
    return list;
  }

  // The open Grafo panel, closed (its drawing and worker stopped) when the panel changes.
  let graphPanel = null;
  function setPanel(which) {
    if (graphPanel) graphPanel.destroy();
    graphPanel = null;
    state.panel = which;
    panel.hidden = !which;
    if (which) node.setAttribute('data-panel', which);
    else node.removeAttribute('data-panel');
    notesTool.setAttribute('aria-expanded', String(which === 'notes'));
    graphTool.setAttribute('aria-expanded', String(which === 'graph'));
  }
  function closePanel() {
    setPanel(null);
    if (state.editor && state.box) state.box.focusEditor();
  }
  function panelHead(name) {
    const row = el('div', undefined, 'panel-head');
    const heading = el('h2', name);
    heading.tabIndex = -1;
    const back = el('button', 'Volver al texto');
    back.type = 'button';
    back.addEventListener('click', closePanel);
    row.append(heading, back);
    return row;
  }
  function focusPanel() {
    const heading = panel.getElementsByTagName('h2')[0];
    if (heading && heading.focus) heading.focus();
  }

  // "Notas": every note of the book by type, each one opening in the editor.
  async function showNotes() {
    setPanel('notes');
    panel.replaceChildren(panelHead('Notas'), el('p', 'Cargando notas…', 'meta'));
    focusPanel();
    let notes;
    try {
      notes = await loadNotes();
    } catch (error) {
      if (state.panel === 'notes') panel.replaceChildren(panelHead('Notas'), el('p', error.message, 'meta'));
      return;
    }
    if (state.panel !== 'notes') return;
    panel.replaceChildren(panelHead('Notas'), ...notesGroups(notes, (name) => open(noteFile(name), true).catch((error) => showError(error.message))));
    focusPanel();
  }

  // "Grafo": the story graph as a sortable table with each node's neighbours.
  function showGraph() {
    setPanel('graph');
    const file = state.file || '';
    const current = file.startsWith('notas/') ? 'note:' + file.slice('notas/'.length, -'.md'.length) : file ? 'scene:' + file : null;
    const list = graphList(state.book, (id) => {
      const file = id.replace(/^(note|scene):/, '');
      return open(id.startsWith('note:') ? noteFile(file) : file, true).catch((error) => showError(error.message));
    }, current);
    graphPanel = list;
    panel.replaceChildren(panelHead('Grafo'), list.node);
    focusPanel();
  }
  notesTool.addEventListener('click', () => (state.panel === 'notes' ? closePanel() : showNotes()));
  graphTool.addEventListener('click', () => (state.panel === 'graph' ? closePanel() : showGraph()));

  // A quote of the help column: its text is selected in the editor and scrolled to.
  async function reveal(file, quoteText, anchor) {
    if (file !== state.file) await open(file, false);
    if (!state.editor) return;
    setPane('text');
    const range = quoteRange(state.editor.getValue(), quoteText, anchor && typeof anchor.start === 'number' ? anchor.start : undefined);
    if (!range) {
      setPane('help');
      helpStatus.textContent = 'No se encuentra la cita en el texto del editor: puede que la hayas cambiado.';
      return;
    }
    helpStatus.textContent = '';
    state.editor.select(range.from, range.to);
  }

  const helpStatus = el('p', '', 'meta help-status');
  helpStatus.setAttribute('role', 'status');

  // The work waiting on the open scene, from the book data the page already holds. Only
  // Ayuda shows it: Concentración builds no card, so nothing to decide appears there.
  function renderHelp() {
    if (mode !== 'help' || !state.file || !latestQueue) {
      help.replaceChildren();
      helpPane.textContent = 'Ayuda';
      return;
    }
    const data = latestQueue;
    const book = state.book;
    const file = state.file;
    const reload = async () => {
      if (book === selectedBook) await renderApp(book);
    };
    const proposals = data.proposals.filter((p) => p.proposal.file === file && (p.proposal.status === 'proposed' || decidedProposals.has(book + '/' + p.proposal.proposal_id)));
    const findings = (data.finding_views || []).filter((f) => f.evidence.some((ev) => ev.file === file));
    const problems = data.findings.filter((f) => f.citations.some((c) => c.source_file === file));
    const claims = data.claims.filter((c) => c.source_file === file && (c.editorial_status === 'proposed' || decidedClaims.has(book + '/' + c.claim_id)));
    const go = (target, quoteText, anchor) => reveal(target, quoteText, anchor).catch((error) => showError(error.message));
    const groups = [
      ['Cambios propuestos', proposals.map((p) => proposalCard(book, p, reload, 'session')), proposals.filter((p) => p.proposal.status === 'proposed').length],
      ['Hallazgos de la trama', findings.map((f) => narrativeFindingCard(book, f, reload, (target, quoteText, anchor) => go(target, quoteText, anchor))), findings.filter((f) => !f.verdict).length],
      ['Posibles problemas', problems.map((f) => {
        const card = findingCard(book, f, reload);
        const quotes = card.getElementsByTagName('blockquote');
        f.citations.forEach((c, i) => { if (quotes[i]) clickable(quotes[i], () => go(c.source_file, c.quote, c.anchor)); });
        return card;
      }), problems.filter((f) => !f.verdict).length],
      ['Afirmaciones por revisar', claims.map((c) => {
        const card = claimCard(book, c, reload, true);
        const quoteEl = card.getElementsByTagName('blockquote')[0];
        if (quoteEl) clickable(quoteEl, () => go(c.source_file, c.anchor.quote, c.anchor));
        return card;
      }), claims.filter((c) => c.editorial_status === 'proposed').length],
    ];
    const heading = el('h2', isNoteFile(file) ? 'Ayuda para esta nota' : 'Ayuda para esta escena');
    const children = [heading];
    if (assistant && !isNoteFile(file)) {
      const ask = el('button', 'Preguntar al asistente por esta escena', 'ask-scene');
      ask.type = 'button';
      ask.addEventListener('click', () => assistant.ask({ kind: 'scene', id: file, label: 'Escena: ' + deskSceneName(file) },
        '¿Qué funciona en esta escena y qué no? Señálame dudas de motivación, consecuencias o conocimiento.', ask));
      children.push(ask);
    }
    children.push(helpStatus);
    let pending = 0;
    for (const [name, cards, waiting] of groups) {
      pending += waiting;
      const group = el('section', undefined, 'help-group');
      group.append(el('h3', name));
      if (!cards.length) group.append(el('p', 'Nada en esta escena.', 'meta'));
      // Its own ids: the same item can also be in the review, hidden behind the desk.
      for (const card of cards) if (card.id) card.id = 'ayuda-' + card.id;
      group.append(...cards);
      children.push(group);
    }
    help.replaceChildren(...children);
    helpPane.textContent = pending ? 'Ayuda (' + pending + ')' : 'Ayuda';
  }

  function emptyBook() {
    dropEditor();
    state.file = null;
    fillPicker();
    title.textContent = '';
    words.textContent = '';
    const toImport = el('button', 'Importar escenas en Revisión');
    toImport.type = 'button';
    toImport.addEventListener('click', async () => {
      await setMode('review');
      goToSection('importar');
    });
    slot.replaceChildren(el('p', 'Este libro aún no tiene escenas.', 'meta'), toImport);
    renderHelp();
  }

  return {
    node,
    resume: false,
    // The focused element is the editor's text (a CodeMirror content or the plain field).
    owns: (element) => Boolean(element && state.editor && (element === state.editor.dom || (slot.contains && slot.contains(element)))),
    focusEditor() {
      if (state.editor && state.box) state.box.focusEditor();
    },
    // Scrolls the window so the caret is between the sticky head and what covers the bottom.
    keepCaretVisible() {
      const rect = state.editor && state.editor.caretRect();
      if (!rect) return;
      const margins = editorMargins(state.editor.head);
      const top = margins.top + 8;
      const bottom = window.innerHeight - margins.bottom - 8;
      if (rect.bottom > bottom) window.scrollBy(0, rect.bottom - bottom);
      else if (rect.top < top) window.scrollBy(0, rect.top - top);
    },
    sync() {
      setPane(state.pane);
      renderHelp();
      renderAnalyse();
    },
    // Called by every render and refresh with the book's data: only the help column and
    // the scene list follow it. Another book closes the desk (its drafts stay in the tab).
    update(book, data) {
      if (book !== state.book) {
        dropEditor();
        state.book = book;
        state.file = null;
        slot.replaceChildren();
      }
      state.scenes = data.scenes || [];
      fillPicker();
      renderHelp();
    },
    async show(file, focus) {
      if (state.book !== selectedBook) this.update(selectedBook, latestQueue || {});
      // A note stays open across modes, as a scene does.
      if (!file && state.editor && isNoteFile(state.file)) {
        renderHelp();
        return undefined;
      }
      const remembered = rememberedScene(state.book);
      const wanted = file || state.file || remembered;
      const target = state.scenes.includes(wanted) ? wanted : state.scenes[0];
      if (!target) return emptyBook();
      if (file || target !== state.file || !state.editor) return open(target, focus);
      renderHelp();
      return undefined;
    },
    // A poll: the saved version of the open scene, compared with the one the editor started from.
    async checkScene() {
      const editor = state.editor;
      if (mode === 'review' || !editor) return;
      const data = await api(docPath(state.book, state.file));
      if (editor !== state.editor) return;
      state.saved = { blob: data.blob, text: data.text };
      showBanner();
    },
  };
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
      const textBox = el('div');
      textBox.append(pre);
      if (typeof data.blob === 'string') {
        // The editor lives in the writing desk, so it survives every mode and every refresh.
        const edit = button('Editar escena', '', () => setMode(lastWritingMode, { file: canonical, focus: true }));
        viewer.append(edit);
      }
      viewer.append(textBox);

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
  // An action that finishes after the person changed book does not render its old book.
  const reload = async (scene, highlight) => {
    if (currentBook === selectedBook) await renderApp(currentBook, scene, highlight);
  };
  const pending = (c) => c.editorial_status === 'proposed';

  let openQuoteHandler = null;
  let scenesFold = null;
  // Opening a scene unfolds the scene list; a quiet reopen (a background refresh) leaves it as the person left it.
  const showScene = (file, quote, anchor, status, quiet) => {
    if (!openQuoteHandler) return undefined;
    if (!quiet && scenesFold) scenesFold.setOpen(true);
    return openQuoteHandler(file, quote, anchor, status, quiet);
  };
  const scenesBox = scenesSection(currentBook, data.scenes || [], reload, (fn) => { openQuoteHandler = fn; });
  const findingsBox = findingsSection(currentBook, data.finding_views || [], reload, (file, quote, anchor, status) => {
    showScene(file, quote, anchor, status);
  });

  const proposed = data.proposals.filter((p) => p.proposal.status === 'proposed');
  const decided = data.proposals.filter((p) => p.proposal.status !== 'proposed');
  const shownProposals = data.proposals.filter((p) => p.proposal.status === 'proposed' || decidedProposals.has(currentBook + '/' + p.proposal.proposal_id));
  const shownClaims = data.claims.filter((c) => pending(c) || decidedClaims.has(currentBook + '/' + c.claim_id));
  const outside = data.claims.filter((c) => c.editorial_status === 'accepted' && !data.canon.some((canonical) => canonical.claim_id === c.claim_id));
  const rejected = data.claims.filter((c) => c.editorial_status === 'rejected');
  const cards = (list, build, place) => list.map((item) => build(currentBook, item, reload, place));
  proposalIndex = new Map(data.proposals.map((p) => [p.proposal.proposal_id, p.proposal]));

  // On a phone only what waits for a decision starts open; tools and reference are
  // one tap away. A section with nothing in it is a single line, so it stays open,
  // and a book without scenes opens the form that gives it some.
  const phone = isPhone();
  const hasScenes = Boolean(data.scenes && data.scenes.length);
  const reference = (count) => !phone || count === 0;
  scenesFold = foldable(scenesBox, 'escenas', reference(hasScenes ? 1 : 0)).fold;

  // Order: first what the writer came to decide (the manuscript, then the analysis
  // of it), then the tools that feed the book, then what is already settled.
  const nodes = [
    foldable(section('Cambios propuestos', cards(shownProposals, proposalCard, 'session'), 'Ningún cambio pendiente.', 'Las decisiones de esta sesión permanecen aquí para confirmar su estado.'), 'cambios', true),
    foldable(findingsBox, 'hallazgos', true),
    foldable(section('Posibles problemas', cards(data.findings, findingCard), 'Sin hallazgos, lo que no demuestra que no haya problemas.'), 'problemas', true),
    foldable(section('Afirmaciones por revisar', cards(shownClaims, claimCard, true), 'Ninguna pendiente.', 'Las decisiones de esta sesión permanecen aquí para confirmar su estado.'), 'afirmaciones', true),
    foldable(importSection(currentBook, reload), 'importar', !phone || !hasScenes),
    foldable(notionImportSection(currentBook, reload), 'notion', !phone),
    scenesBox,
    foldable(section('Canon', cards(data.canon, claimCard), 'El canon está vacío.', 'Solo hechos narrados aceptados por una persona y con evidencia válida. Aceptar un cambio de texto no aprueba sus afirmaciones.'), 'canon', reference(data.canon.length)),
    foldable(section('Afirmaciones fuera del Canon', cards(outside, claimCard), 'Ninguna afirmación aceptada fuera del Canon.', 'Una afirmación aceptada puede seguir fuera del Canon por su tipo o por su evidencia.'), 'fuera-del-canon', reference(outside.length)),
    foldable(section('Afirmaciones rechazadas', cards(rejected, claimCard), 'Ninguna afirmación rechazada.', 'Las afirmaciones rechazadas no forman parte del Canon.'), 'rechazadas', reference(rejected.length)),
    foldable(section('Historial de cambios del manuscrito', cards(decided, proposalCard, 'history'), 'Sin decisiones todavía.', 'Aceptar una propuesta cambia el manuscrito, pero no convierte sus afirmaciones en Canon. Las propuestas rechazadas no cambian el texto.'), 'historial', reference(decided.length)),
  ];
  const counts = {
    cambios: proposed.length,
    hallazgos: (data.finding_views || []).filter((f) => !f.verdict).length,
    problemas: data.findings.filter((f) => !f.verdict).length,
    afirmaciones: data.claims.filter(pending).length,
  };
  return { nodes, counts, openQuote: (...args) => showScene(...args) };
}

async function renderApp(selectedBookId, selectedScene, highlight) {
  const seq = ++renderSeq;
  const wanted = selectedBookId || preferredBook();
  selectedBook = wanted || null;
  // Nothing refreshes in the background until this render has settled.
  view = null;
  openScene = null;
  const { books } = await api('/books');
  // A newer render started meanwhile: it owns the page.
  if (seq !== renderSeq) return;
  app.replaceChildren();

  if (!books.length) {
    // No book, no scene to write: the page is the review whatever mode was chosen.
    showMode('review');
    app.append(el('p', 'Tu cuenta todavía no tiene acceso a ningún libro. Crea uno para empezar:'));
    app.append(createBookSection(async (newId) => renderApp(newId)));
    return;
  }

  const found = books.some((b) => b.book_id === wanted);
  const currentBook = found ? wanted : books[0].book_id;
  currentBookTitle = books.find((b) => b.book_id === currentBook).title;
  selectedBook = currentBook;
  recordBook(currentBook);
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
  const toggleBtn = button('Crear otro libro', 'create-toggle', () => {
    const open = createBox.style.display === 'none';
    createBox.style.display = open ? 'block' : 'none';
    toggleBtn.setAttribute('aria-expanded', String(open));
  });
  toggleBtn.setAttribute('aria-expanded', 'false');
  toolbar.append(toggleBtn, modeSwitchNode());
  const nav = sectionNav();
  const notice = el('p', undefined, 'notice');
  notice.setAttribute('role', 'status');
  notice.hidden = true;
  app.append(toolbar, createBox, nav.node, notice);
  // The same desk, editor included, goes back into the page: a render never rebuilds it.
  if (desk) app.append(desk.node);
  // A book that is gone or no longer shared is said in one line, never a silent switch.
  if (wanted && !found) {
    const gone = el('p', GONE_NOTICE + '«' + currentBookTitle + '».', 'notice');
    gone.setAttribute('role', 'status');
    app.append(gone);
  }

  const state = await apiState('/books/' + currentBook);
  if (seq !== renderSeq) return;
  const built = bookSections(currentBook, state.data);
  app.append(...built.nodes);
  nav.setCounts(built.counts);
  if (seq === renderSeq) {
    view = { book: currentBook, tag: state.tag, pending: null, sections: built.nodes, notice, nav };
    latestQueue = state.data;
    showSceneInReview = (file) => built.openQuote(file);
    if (assistant) assistant.pageChanged();
    showMode(mode);
    if (mode !== 'review') {
      ensureDesk().update(currentBook, state.data);
      await desk.show();
    } else if (desk) {
      desk.update(currentBook, state.data);
    }
    syncNav();
  }
  if (selectedScene) {
    await built.openQuote(selectedScene, highlight?.quote, highlight?.anchor, highlight?.status);
  }
}

// Unfinished work a re-render would destroy: a focused field, text or files not
// yet sent, or an open dialog (the account menu included). The assistant panel is
// never re-rendered by a refresh, so its field does not count.
function hasWorkInProgress() {
  const active = document.activeElement;
  const inPanel = active && active.closest && active.closest('#assistant');
  // The scene editor lives in the writing desk, which a refresh never re-renders either.
  const inEditor = desk && desk.owns(active);
  if (active && !inPanel && !inEditor && ['INPUT', 'TEXTAREA', 'SELECT'].includes(active.tagName)) return true;
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
    // A card in a folded section has no box and would report top 0.
    if (!card.id || card.offsetParent === null) continue;
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
  const active = document.activeElement;
  const focused = active && active.closest ? active.closest('article') : null;
  const focusedFold = active && active.className === 'fold' ? active.closest('section') : null;
  for (const node of current.sections) node.remove();
  app.append(...built.nodes);
  current.sections = built.nodes;
  current.nav.setCounts(built.counts);
  showSceneInReview = (file) => built.openQuote(file);
  const anchored = anchor && document.getElementById(anchor.id);
  if (anchored) window.scrollBy(0, anchored.getBoundingClientRect().top - anchor.top);
  else window.scrollTo(0, scrollY);
  const refocus = focused && focused.id && document.getElementById(focused.id);
  if (refocus) refocus.focus({ preventScroll: true });
  const refold = focusedFold && document.getElementById(focusedFold.id);
  if (refold && refold.fold) refold.fold.toggle.focus({ preventScroll: true });
  latestQueue = data;
  if (desk) desk.update(current.book, data);
  if (assistant) assistant.pageChanged();
  syncNav();
  return true;
}

// One poll. It only ever reads; it never renders over unfinished work, over a
// newer render, or while one of the person's own actions is running.
async function refreshOnce() {
  const current = view;
  if (!current || refreshing || document.hidden || actionsRunning > 0) return;
  refreshing = true;
  let lost = false;
  try {
    const state = await apiState('/books/' + current.book, current.tag);
    if (current !== view) return;
    if (state.changed) {
      current.tag = state.tag;
      current.pending = state.data;
    }
    refreshDelay = REFRESH_MS;
    // The open scene of the desk: its editor is never touched, a banner says it changed.
    if (desk) await desk.checkScene().catch(() => {});
    if (current !== view || !current.pending || actionsRunning > 0) return;
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
  } catch (error) {
    // The book is gone or no longer shared: render again, which explains the switch.
    if (current === view && (error.status === 403 || error.status === 404)) lost = true;
    // Any other failed poll is not the person's problem: retry later, and less often.
    else refreshDelay = Math.min(refreshDelay * 2, REFRESH_MAX_MS);
  } finally {
    refreshing = false;
  }
  if (lost) await renderApp(current.book).catch((err) => showError(err.message));
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

// Leaving the page with an unsaved scene edit asks first; the text also stays in this tab's draft.
window.addEventListener('beforeunload', (event) => {
  if (unsavedEdit && unsavedEdit()) {
    event.preventDefault();
    event.returnValue = '';
  }
});
window.addEventListener('scroll', queueSpy, { passive: true });
window.addEventListener('resize', queueSpy);

window.addEventListener('load', async () => {
  try {
    await window.Clerk.load({ ui: { ClerkUI: window.__internal_ClerkUICtor } });
    if (!window.Clerk.isSignedIn) {
      // Signed out: the assistant's transcript of whoever used this tab goes.
      forgetTab(['rewrite.assistant.']);
      const box = el('div', undefined, 'sign-in');
      app.replaceChildren(box);
      window.Clerk.mountSignIn(box);
      return;
    }
    window.Clerk.mountUserButton(document.getElementById('user'));
    await rememberPerson();
    mode = readMode();
    if (mode !== 'review') lastWritingMode = mode;
    showMode(mode);
    // Signing out (or another account) while the page is open.
    if (window.Clerk.addListener) {
      window.Clerk.addListener((resources) => {
        if (resources && !resources.session) forgetTab(['rewrite.assistant.']);
      });
    }
    if (assistant) assistant.start();
    startRefresh();
    await renderApp();
  } catch (error) {
    app.replaceChildren();
    showError(error.message || 'No se pudo cargar la página');
  }
});
`;
