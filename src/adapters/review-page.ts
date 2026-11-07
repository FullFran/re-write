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
h3 { margin: 20px 0 8px; font-size: 16px; }
main { max-width: 760px; margin: 0 auto; padding: 16px; }
article { border-top: 1px solid var(--line); padding: 16px 0; }
blockquote { margin: 8px 0; padding-left: 12px; border-left: 3px solid var(--line); }
.meta { color: var(--muted); font: 13px/1.4 system-ui, sans-serif; overflow-wrap: anywhere; }
pre { overflow-x: auto; padding: 12px; border: 1px solid var(--line); font: 13px/1.5 ui-monospace, monospace; white-space: pre-wrap; overflow-wrap: anywhere; }
.actions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 12px; }
button { min-height: 44px; padding: 8px 16px; border: 1px solid var(--line); border-radius: 6px; background: transparent; color: inherit; font: 15px system-ui, sans-serif; cursor: pointer; }
button.accept { border-color: var(--accept); color: var(--accept); }
button.reject { border-color: var(--reject); color: var(--reject); }
button.active { border-color: var(--ink); background: var(--line); font-weight: bold; }
button:disabled { opacity: .5; cursor: default; }
select, input[type=text] { min-height: 44px; max-width: 100%; font: 15px system-ui, sans-serif; padding: 8px 12px; border: 1px solid var(--line); border-radius: 6px; background: transparent; color: inherit; }
input[type=file] { font: 14px system-ui, sans-serif; }
[role=alert] { color: var(--reject); }
[role=status] { color: var(--accept); font-weight: 500; }
.toolbar { display: flex; flex-wrap: wrap; gap: 12px; align-items: center; margin-bottom: 24px; padding-bottom: 16px; border-bottom: 1px solid var(--line); }
.card-box { border: 1px solid var(--line); border-radius: 6px; padding: 16px; margin: 16px 0; }
.form-row { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; margin-top: 8px; }
.scenes-grid { display: flex; flex-wrap: wrap; gap: 8px; margin: 12px 0; }
.scene-viewer { margin-top: 16px; border-top: 1px solid var(--line); padding-top: 16px; }
mark { background: #ffe066; color: inherit; padding: 2px 4px; border-radius: 3px; }
@media (prefers-color-scheme: dark) { mark { background: #7a6200; color: inherit; } }
.badge { display: inline-block; padding: 2px 6px; border-radius: 4px; font: 12px/1.2 system-ui, sans-serif; border: 1px solid var(--line); margin-right: 6px; }
.badge-stale { border-color: var(--reject); color: var(--reject); }
.clickable-quote { cursor: pointer; text-decoration: underline; text-decoration-style: dotted; }
.clickable-quote:hover { background: var(--line); }
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
      quoteEl.addEventListener('click', () => {
        openQuote(ev.file, ev.quote, ev.anchor, ev.status);
      });
    }
    const statusText = ev.status === 'valid' ? 'válida' : (ev.status === 'stale' ? 'desactualizada' : ev.status);
    let detail = ev.file + ' · evidencia: ' + statusText;
    if (ev.status === 'stale') {
      detail += ' (el texto alrededor de la cita cambió en la escena)';
    }
    evBox.append(quoteEl, el('p', detail, 'meta' + (ev.status === 'stale' ? ' badge-stale' : '')));
    card.append(evBox);
  }

  if (finding.evidence_status === 'stale') {
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
    noteInput.value = finding.verdict.note;
  }
  const rate = (verdict) => async () => {
    const note = noteInput.value.trim() || undefined;
    await api('/books/' + book + '/findings/' + finding.finding_id, { verdict, note });
    await reload();
  };
  const usefulBtn = button('Me ayuda', finding.verdict?.verdict === 'useful' ? 'active' : '', rate('useful'));
  const noiseBtn = button('Ruido', finding.verdict?.verdict === 'noise' ? 'active' : '', rate('noise'));
  ratingRow.append(noteInput, usefulBtn, noiseBtn);
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
  const loadScene = async (sceneFile, highlight) => {
    const canonical = sceneFile.startsWith('scenes/') ? sceneFile : 'scenes/' + sceneFile;
    if (activeBtn) activeBtn.classList.remove('active');
    for (const child of grid.children) {
      if (child.textContent === canonical || child.textContent === sceneFile) {
        child.classList.add('active');
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

      if (highlight && highlight.status === 'stale') {
        const staleAlert = el('p', 'Aviso: La evidencia está desactualizada. El texto alrededor de la cita cambió en la escena.', 'meta badge-stale');
        viewer.append(staleAlert);
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
          setTimeout(() => mark.scrollIntoView({ block: 'center', behavior: 'smooth' }), 50);
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
          await loadScene(canonical, highlight);
          await reloadBook();
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
          await loadScene(canonical, highlight);
          await reloadBook();
        };
        for (const p of data.proposals) {
          propBox.append(proposalCard(book, p, reloadScene));
        }
      } else {
        propBox.append(el('p', 'Sin cambios pendientes para esta escena.', 'meta'));
      }
      viewer.append(propBox);
      viewer.scrollIntoView({ behavior: 'smooth' });
    } catch (error) {
      viewer.replaceChildren(el('p', error.message, 'meta'));
    }
  };

  if (registerOpenQuote) {
    registerOpenQuote((file, quote, anchor, status) => {
      loadScene(file, { quote, anchor, status });
    });
  }

  for (const scene of scenes) {
    const btn = button(scene, '', () => loadScene(scene, null));
    grid.append(btn);
  }
  box.append(grid, viewer);
  return box;
}

async function renderApp(selectedBookId) {
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
    createBox.style.display = createBox.style.display === 'none' ? 'block' : 'none';
  });
  toolbar.append(toggleBtn);
  app.append(toolbar, createBox);

  const reload = () => renderApp(currentBook);
  const data = await api('/books/' + currentBook);
  const pending = (c) => c.editorial_status === 'proposed';

  let openQuoteHandler = null;
  const scenesBox = scenesSection(currentBook, data.scenes || [], reload, (fn) => { openQuoteHandler = fn; });
  const findingsBox = findingsSection(currentBook, data.finding_views || [], reload, (file, quote, anchor, status) => {
    if (openQuoteHandler) openQuoteHandler(file, quote, anchor, status);
  });

  app.append(
    importSection(currentBook, reload),
    notionImportSection(currentBook, reload),
    scenesBox,
    findingsBox,
    section('Cambios propuestos', data.proposals.filter((p) => p.proposal.status === 'proposed').map((p) => proposalCard(currentBook, p, reload)), 'Ningún cambio pendiente.'),
    section('Posibles problemas', data.findings.map((f) => findingCard(currentBook, f, reload)), 'Sin hallazgos, lo que no demuestra que no haya problemas.'),
    section('Afirmaciones por revisar', data.claims.filter(pending).map((c) => claimCard(currentBook, c, reload)), 'Ninguna pendiente.'),
    section('Canon', data.canon.map((c) => claimCard(currentBook, c, reload)), 'El canon está vacío.'),
    section('Historial de cambios', data.proposals.filter((p) => p.proposal.status !== 'proposed').map((p) => proposalCard(currentBook, p, reload)), 'Sin decisiones todavía.'),
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
    await renderApp();
  } catch (error) {
    app.replaceChildren();
    showError(error.message || 'No se pudo cargar la página');
  }
});
`;
