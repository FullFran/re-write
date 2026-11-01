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
<meta name="viewport" content="width=device-width, initial-scale=1">
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
:root { color-scheme: light dark; --ink: #1c1b19; --paper: #faf8f4; --line: #d9d4ca; --muted: #6b665c; --accept: #1f6b45; --reject: #a32a2a; }
@media (prefers-color-scheme: dark) { :root { --ink: #ece8df; --paper: #1a1917; --line: #3a372f; --muted: #a39d90; --accept: #5fc08f; --reject: #ef8585; } }
* { box-sizing: border-box; }
body { margin: 0; background: var(--paper); color: var(--ink); font: 16px/1.5 Georgia, 'Times New Roman', serif; }
header { display: flex; justify-content: space-between; align-items: center; padding: 12px 16px; border-bottom: 1px solid var(--line); }
h1 { margin: 0; font-size: 20px; }
h2 { margin: 32px 0 8px; font-size: 18px; }
main { max-width: 760px; margin: 0 auto; padding: 16px; }
article { border-top: 1px solid var(--line); padding: 16px 0; }
blockquote { margin: 8px 0; padding-left: 12px; border-left: 3px solid var(--line); }
.meta { color: var(--muted); font: 13px/1.4 system-ui, sans-serif; overflow-wrap: anywhere; }
pre { overflow-x: auto; padding: 12px; border: 1px solid var(--line); font: 13px/1.5 ui-monospace, monospace; white-space: pre-wrap; overflow-wrap: anywhere; }
.actions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 12px; }
button { min-height: 44px; padding: 8px 16px; border: 1px solid var(--line); border-radius: 6px; background: transparent; color: inherit; font: 15px system-ui, sans-serif; cursor: pointer; }
button.accept { border-color: var(--accept); color: var(--accept); }
button.reject { border-color: var(--reject); color: var(--reject); }
button:disabled { opacity: .5; cursor: default; }
select { min-height: 44px; max-width: 100%; font: 15px system-ui, sans-serif; }
[role=alert] { color: var(--reject); }
`;

export const REVIEW_JS = String.raw`
'use strict';

const app = document.getElementById('app');

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

function button(label, className, run) {
  const node = el('button', label, className);
  node.type = 'button';
  node.addEventListener('click', async () => {
    node.disabled = true;
    try {
      await run();
    } catch (error) {
      showError(error.message);
      node.disabled = false;
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
  card.append(el('p', claim.statement));
  card.append(quote(claim.anchor.quote, claim.source_file + ' · ' + claim.epistemic_kind + ' · evidencia: ' + claim.evidence_status + ' · propuesto por: ' + claim.extractor));
  if (claim.uncertainty) card.append(el('p', 'Incertidumbre: ' + claim.uncertainty, 'meta'));
  if (claim.editorial_status === 'proposed') {
    const actions = el('div', undefined, 'actions');
    const decide = (decision) => () => api('/books/' + book + '/claims/' + claim.claim_id, { decision }).then(reload);
    if (claim.evidence_status === 'valid') actions.append(button('Aceptar', 'accept', decide('accept')));
    actions.append(button('Rechazar', 'reject', decide('reject')));
    card.append(actions);
  } else {
    card.append(el('p', 'Estado: ' + claim.editorial_status, 'meta'));
  }
  return card;
}

const VERDICTS = { confirmed: 'Es un error real', deliberate_mystery: 'Misterio deliberado', false_positive: 'Falso positivo' };

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

function proposalCard(book, { proposal, diff, applicable }, reload) {
  const card = el('article');
  card.append(el('p', proposal.rationale));
  card.append(el('pre', diff));
  if (proposal.status !== 'proposed') {
    card.append(el('p', 'Estado: ' + proposal.status + (proposal.result_commit ? ' · versión ' + proposal.result_commit.slice(0, 10) : ''), 'meta'));
    return card;
  }
  const actions = el('div', undefined, 'actions');
  const decide = (decision) => () => api('/books/' + book + '/proposals/' + proposal.proposal_id, { decision }).then(reload);
  if (applicable) actions.append(button('Aceptar cambio', 'accept', decide('accept')));
  else card.append(el('p', 'La escena ha cambiado desde esta propuesta: ya no se puede aplicar.', 'meta'));
  actions.append(button('Rechazar', 'reject', decide('reject')));
  card.append(actions);
  return card;
}

function section(title, cards, empty) {
  const box = el('section');
  box.append(el('h2', title));
  if (!cards.length) box.append(el('p', empty, 'meta'));
  box.append(...cards);
  return box;
}

async function showBook(book, picker) {
  const reload = () => showBook(book, picker);
  const data = await api('/books/' + book);
  const pending = (c) => c.editorial_status === 'proposed';
  app.replaceChildren(picker);
  app.append(
    section('Cambios propuestos', data.proposals.filter((p) => p.proposal.status === 'proposed').map((p) => proposalCard(book, p, reload)), 'Ningún cambio pendiente.'),
    section('Posibles problemas', data.findings.map((f) => findingCard(book, f, reload)), 'Sin hallazgos, lo que no demuestra que no haya problemas.'),
    section('Afirmaciones por revisar', data.claims.filter(pending).map((c) => claimCard(book, c, reload)), 'Ninguna pendiente.'),
    section('Canon', data.canon.map((c) => claimCard(book, c, reload)), 'El canon está vacío.'),
    section('Historial de cambios', data.proposals.filter((p) => p.proposal.status !== 'proposed').map((p) => proposalCard(book, p, reload)), 'Sin decisiones todavía.'),
  );
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
    const { books } = await api('/books');
    if (!books.length) {
      app.replaceChildren(el('p', 'Tu cuenta todavía no tiene acceso a ningún libro.'));
      return;
    }
    const picker = el('select');
    picker.setAttribute('aria-label', 'Libro');
    for (const book of books) {
      const option = el('option', book.title);
      option.value = book.book_id;
      picker.append(option);
    }
    picker.addEventListener('change', () => showBook(picker.value, picker).catch((error) => showError(error.message)));
    await showBook(books[0].book_id, picker);
  } catch (error) {
    app.replaceChildren();
    showError(error.message || 'No se pudo cargar la página');
  }
});
`;
