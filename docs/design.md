# Design rules for the web pages

The rules the review page (`src/adapters/review-page.ts`) follows. A new page should
follow them too, and reuse the custom properties instead of new literals. The pages
are tools for reading prose and deciding on it: restraint comes before decoration.

## What the review page is for, and its order

A writer opens the page to decide: accept or reject a change, rate a finding, review
a claim. So the page is ordered by what waits for them, not by how a book is built:

1. **Pending work**: Cambios propuestos, Hallazgos de la trama, Posibles problemas,
   Afirmaciones por revisar. Changes to the manuscript come first because they are
   the only decisions that alter the text; the analysis of it follows.
2. **Tools that feed the book**: Importar escenas Markdown, Importar desde Notion,
   Navegar escenas. Import stays above the scene list, which points to it when empty.
3. **What is already settled**: Canon, Afirmaciones fuera del Canon, Afirmaciones
   rechazadas, Historial de cambios del manuscrito.

On a phone only group 1 starts open. Groups 2 and 3 start folded behind their
headings, with two exceptions: a section with nothing in it is a single line and
stays open (its explanation appears once it holds something), and a book without
scenes opens the Markdown import form. From 40em up everything starts open.

## Constraints

- No framework, no build step, no dependency: one module exports the HTML, the CSS
  and the script.
- System fonts only. No web fonts and no images from other origins.
- Untrusted text (manuscripts, proposals) is rendered with `textContent`.
- UI copy is Spanish; code, comments and docs are English.

## Colour roles

Every colour has a role; none is added for show. Both themes are defined by the same
custom properties (`prefers-color-scheme`), and `tests/review-mobile.test.ts` checks
the pairs below against WCAG AA.

| Token | Role | Used on |
| --- | --- | --- |
| `--paper` | Page background, the only surface | everything |
| `--ink` | Text | `--paper`, `--accept-bg`, `--reject-bg`, `--mark`, `--pressed` |
| `--muted` | Secondary text (metadata, hints) | `--paper`, `--pressed` |
| `--line` | Separators and card outlines (decorative) | — |
| `--edge` | Boundary of a control (3:1 against `--paper`) | inputs, buttons, quotes |
| `--accept`, `--accept-bg` | Accepting, additions, good news | filled primary button, added diff rows, status |
| `--reject`, `--reject-bg` | Rejecting, deletions, errors, stale evidence | reject button, removed diff rows, alerts |
| `--mark` | The highlighted quote in a scene | `mark` |
| `--pressed` | Hover and the selected option | buttons |

Colour never carries meaning alone: a diff row has a label (`− Eliminado:`,
`+ Añadido:`), a bar and a strike-through or underline; a state badge has its word;
the selected rating has `aria-pressed`.

## Scales

- Spacing: `--space-1` to `--space-7` = 4, 8, 12, 16, 24, 32, 48 px. No other gaps.
- Type: `--text-xs` 13, `--text-sm` 14, `--text-md` 16, `--text-lg` 18, `--text-xl`
  22 px, written in `rem` so the reader's font size is respected.
- Fonts: `--font-prose` (serif) for anything the writer wrote or will read as prose,
  `--font-ui` (system sans) for controls and metadata, `--font-code` for the unified diff.
- `--measure` (46rem) is the reading width; the page is one centred column at every size.
- `--tap` (44 px) is the minimum height of every control; `--radius` is 8 px.
- `--nav-h` is the height of the section navigation while it sticks to the top
  (0 where it is a side column). Anything else that sticks or floats at the top, and
  every `scroll-margin-top`, adds it.

## Layout and breakpoints

- Base styles are fluid and already work on a phone. Three breakpoints for the page:
  `max-width: 40em` (phone: full-width controls, sticky decision bar, tools and
  reference folded, the mode switch docked at the bottom), `min-width: 48em` (more
  padding) and `min-width: 75em` (the section navigation moves beside the column). The
  writing desk adds one of its own, `64em`: below it Ayuda's text and help are two panes,
  from it they are two columns.
- Nothing scrolls sideways: `overflow-wrap: anywhere` on `body`, `pre-wrap` for
  diffs and code, `min-width: 0` on flexible controls.
- `viewport-fit=cover` is set, so the page pads itself with `env(safe-area-inset-*)`
  (`--gutter` for the sides, the header for the top, the decision bar and `main` for the bottom).
- Zooming is never disabled.

## Section navigation and folding

- One `nav` landmark (`.section-nav`, `aria-label="Secciones"`) with a link per
  group of sections. Below 75em it is a single row that sticks to the top of the
  screen and scrolls sideways; it never wraps into a second row. From 75em it is a
  fixed list in the empty space left of the column. The decision bar owns the bottom
  edge, so the two never meet.
- A link shows how many items wait in its section; no number means none. The link
  for the section being read has `aria-current="location"`, bold text and a filled
  shape. A link does not change the address (Clerk routes through the hash): it
  unfolds its section, scrolls to it and moves focus to its heading.
- Every section heading is a button (`.fold`, `aria-expanded`, `aria-controls`)
  that folds its section with `hidden`. Folded content stays in the page, so a form
  keeps its text and files and still counts as unsent work. Nothing is folded
  without its heading visible.
- State survives a re-render: a fold chosen by hand is remembered for the session,
  and the background refresh replaces the sections but keeps the navigation node,
  only updating its counts. The refresh anchor ignores cards inside folded sections.

## Controls

- Text fields, selects and buttons use `--text-md` (16 px): iOS zooms the page when a
  focused field is smaller.
- One primary action per group: filled `--accept`. Reject is outlined in `--reject`.
  Accept and reject sit `--space-4` apart.
- On a phone the accept/reject bar of a card (`.decision`) sticks to the bottom of the
  screen while its card is being read. It is opaque, it never contains a text field,
  and it only appears once 120 px of its card are visible (`--peek`).
- Every control has a visible label or an `aria-label`; focus is always visible
  (`:focus-visible`). An `aria-label` starts with the visible words
  ("Deshacer: revertir cambio de texto"), so speech control finds the button by what it shows.
- Taking a decision back has two names, because the two do different things.
  **Deshacer decisión editorial** reopens a claim, a finding verdict or a rejected
  proposal: nothing in the text changes. **Revertir cambio de texto** undoes an applied
  change through an inverse proposal a person must accept, and is confirmed first in a
  box inside the card (`.confirm`, `role="dialog"` only while open). Right after a
  decision the card reads "Decisión guardada · Deshacer", with no timer; in Historial
  the same action is **Volver a revisar**. These buttons are outlined, below the card's
  content, never in the sticky `.decision` bar.

## Scene editor

- The editor is CodeMirror 6 (`editor/`, served as `/review/editor.js`) holding the
  scene's Markdown exactly as stored. Three views of that one text, chosen above it and
  remembered per account in `localStorage` (`rewrite:editor-view:<hash of the person>`, as the drafts):
  - **Vista previa en vivo** (default): as in Obsidian's live preview, Markdown markers
    are hidden except on the lines the cursor or the selection touches; headings,
    `*cursiva*`, `**negrita**`, quotes, lists (`•`) and scene breaks (`***`, shown as
    `⁂`) are styled in place. The manuscript font (`--font-prose`), soft wrap, a 40em
    measure and no gutter.
  - **Markdown**: the source with every marker visible, highlighted, in `--font-code`,
    with line numbers.
  - **Lectura**: the scene rendered and read-only. It is built as elements from the
    Markdown syntax tree; scene text only becomes text nodes, HTML in a scene stays
    text and links keep their words without becoming links.
- The views are decorations only: the saved bytes are the text in the editor, whatever
  the view. Text is 16 px or more in every view, so iOS does not zoom on focus; the
  browser's spellcheck, autocorrect, capitals, dictation and IME work as in a text field.
- When `/review/editor.js` is missing or does not load within 10 s, **Editar escena**
  opens a plain text field instead, with the same saving rules below and no views.
- The editor (CodeMirror or the text field) shows every line break as LF, so a scene
  stored with only LF or only CRLF keeps its breaks on save, and opening and closing a
  scene is never an unsaved change.
- A scene that mixes line breaks (or has a lone CR) opens read-only, with one line
  explaining why and **Normalizar los finales de línea y editar**: that action is the
  only way its breaks change, and the save says so.
- **Guardar** and Ctrl/Cmd+S do nothing while a save is in flight or when nothing
  changed.
- **Guardar** (or Ctrl/Cmd+S) saves explicitly; there is no autosave. The status line
  below it (`role="status"`) says **Cambios sin guardar**, **Guardando…**, **Guardado**
  or the error, and an error always adds that the text is still there.
- Unsaved text is kept in the tab's `sessionStorage` only, never `localStorage`: it
  survives a re-render or a reload of the tab and is gone when the tab closes. Leaving
  the page with unsaved text asks first.
- When the scene changed since it was opened, the save is refused and the page shows
  the saved version next to the person's text with two actions: **Usar la versión
  guardada** and **Guardar mi versión encima**. Nothing is overwritten without that
  second, explicit choice.
- The editor lives in the writing desk (see Modes), which the background refresh never
  re-renders: news keeps reaching the rest of the page while the person writes. When the
  open scene is saved somewhere else, the desk says so in one line
  (**Esta escena ha cambiado fuera de este editor.**), with **Cargar la versión guardada**
  only when nothing is unsaved; otherwise saving shows the comparison above.

## Modes

Issue #101: the writer chooses how much help is on screen. One switch, three modes, all
in the same page and over the same text:

| Mode | What is on screen |
| --- | --- |
| **Concentración** | The writing desk only: the open scene in the editor. No review section, no section navigation, no card, no analysis; the assistant is closed and never opens by itself. |
| **Ayuda RE;write** | The same desk plus **Ayuda para esta escena**: the scene's proposed changes, findings, possible problems and claims, with their usual actions. |
| **Revisión** | The full review page as described above; the desk is hidden, not closed. |

- **The switch** is a group (`.mode-switch`, `role="group"`, `aria-label="Modo"`) of three
  buttons with `aria-pressed`, at the end of the book row. On a phone it is a dock fixed to
  the bottom, above the safe area; `--dock-h` is its height, and the decision bar, the
  assistant button and the end of the page stop above it. A tap on it does not take the
  focus from the text (its `mousedown` is cancelled); coming back from Revisión, where the
  hidden editor loses the focus, puts the caret back where it was if it was in the text.
- **Remembered** per person in `localStorage` (`rewrite:mode:<hash of the person>`, as the
  editor view), and so is the scene open in the desk for each book
  (`rewrite:desk-scene:<hash>:<book>`). Without a choice the page opens in Revisión; without
  a book it is Revisión whatever was chosen.
- **The writing desk** (`#desk`, a `section` labelled **Escritura**) is built once and moved
  back into the page by every render: a decision, a refresh or a mode change never rebuilds
  the editor, so the text, the cursor, the selection and the undo history stay. Its head:
  **‹** / **›** (named **Escena anterior** / **Escena siguiente**; the words show from 40em)
  around a scene list (`aria-label="Escena"`), the scene's title (its first heading, else the
  file name) and its word count. **Guardar**, **Cerrar editor** and the save status sit above
  the text and stick to the top while writing. **Editar escena** in Revisión opens that scene
  here; **Cerrar editor** goes back to Revisión at that scene.
- **Ayuda para esta escena** (an `aside`) is built only in Ayuda, from the book data the page
  already holds, filtered to the open scene. From 64em it is a column on the right of the
  editor that scrolls on its own; with the assistant open it goes under the text up to 100em,
  where there is room for three columns. Below 64em **Texto** and **Ayuda (n)** swap the two
  panes; *n* counts what waits for a decision. Its cards have their own ids (`ayuda-…`).
- **A quote** of a finding, a possible problem or a claim selects its words in the editor
  and scrolls them to the middle. The editor holds the raw Markdown and quotes are literal, so
  the quote is looked up in the editor's text (the occurrence nearest its anchor wins); when
  the person already rewrote it, the help says **No se encuentra la cita en el texto del
  editor** instead of selecting something else. Reading view gives way to the live preview to
  show the selection.
- **The assistant**: switching to Concentración closes the panel; its button stays, outlined
  instead of filled. In Ayuda, **Preguntar al asistente por esta escena** opens it with the
  scene as the item.
- The editor module exposes `select(from, to)` for this; new editor behaviour belongs in its
  own CodeMirror extension module in `editor/src/`, added to the editor's extension list as
  `live-preview.js` and `wikilinks.js` are.

## Notes, wikilinks and the graph list

Issue #115, slice 2 ([notes and graph](notes-and-graph.md)).

- **Wikilinks in the editor.** In **Vista previa en vivo** `[[Nota]]`, `[[Nota|texto]]` and
  `[[Nota#Sección]]` show only the text a reader sees (the text after `|`, else the note name),
  underlined in `--accept`; the brackets come back on the lines the cursor touches, like every
  other marker. A link that names no note (or more than one) is `--muted` with a dashed
  underline. **Markdown** shows links raw; **Lectura** shows their text. A click on a link shown
  as text, Ctrl/Cmd+click anywhere on a link, or Enter (or Ctrl/Cmd+Enter) with the cursor
  between its brackets opens the note. A link that resolves to nothing says so in the desk's
  status line (`role="status"`) instead of opening anything.
- **`[[` completes** note names and aliases, with case and accents ignored (the server's
  folding); prefix matches first. An alias inserts `Nota|alias`, so the link shows the alias and
  still names the note; `]]` is added unless it is already there. Each option is at least
  `--tap` high.
- **Notas** and **Grafo**, a group (`aria-label="Notas y grafo del libro"`) in the desk's head in
  both writing modes, show a panel over the text (`aria-expanded`, `aria-controls="desk-panel"`);
  the editor stays mounted behind it, so text, cursor and undo history stay. **Volver al texto**
  closes it. The panel's heading takes the focus when it opens.
- **Notas** groups the notes by type (Personajes, Lugares, Objetos, Tramas, Otras, with counts)
  and lists each note's aliases. A note opens in the same editor as a scene, with the same views,
  draft, save, conflict and banner rules; the scene list then reads **Nota: <name>**.
- **A note's backlinks** sit under its editor: **Menciones enlazadas (n)** and **Menciones sin
  enlazar (n)**, each with the place (scene or note and line) and the sentence. The place opens
  that scene or note with the mention selected.
- **Grafo** is first a table (`caption` **Nodos del grafo**): Nodo, Tipo, Grado, Escenas, sorted
  by degree; each header is a button that sorts by it (`aria-sort`). Each node is a button:
  Up/Down move between nodes, Home/End to the first and the last, Enter chooses one. The chosen
  row is marked, a live line (`role="status"`) says **Elegido: <nodo>, <tipo>, grado <n>.**, and
  **Vecinos de <nodo> (n)** lists its neighbours with how they are joined (link, shared scenes,
  mentions) and **Abrir <nodo>**. **Mostrar escenas** (off by default) adds the scenes;
  **Hasta** cuts the graph at a scene. This table is the way to the graph data that never needs a
  canvas, and the view phones start with.

## Messages

- An error is `role="alert"`; the newest one stays at the top of the screen, below
  the section navigation. When another tab changed the item (409), the error carries a
  **Recargar** button.
- News that cannot be shown yet is a floating `role="status"` box (`.notice`), also
  below the navigation. It is in
  the page from the start, empty, and gets its text when there is news, so screen
  readers announce it. Do not add a permanent `role="dialog"` or `aria-modal`
  element: the review page pauses its refresh while one exists.

## Assistant panel

With the embedded engine on, the review page carries the assistant (`src/adapters/engine-page.ts`, appended to the page's own styles and script). It is part of the page, not a page of its own.

- **One landmark, never a dialog.** The panel is an `aside` (`#assistant`, `aria-label="Asistente"`) outside `main`. It has no `role="dialog"` or `aria-modal`: the page pauses its refresh while one exists. The background refresh never re-renders the panel, so a focused or filled panel field does not hold the refresh back (`hasWorkInProgress` ignores it); a field in the page still does.
- **Where it sits.** From 75em it is a fixed column of 26rem on the right; the body gets the same right padding, so the page column re-centres in the room left and stays usable. The section list moves back to the top row while the panel is open (there is no room beside the column) and `--nav-h` follows. Below 75em it is a bottom sheet up to 88% of the screen, with a scrim that closes it on a tap; the page keeps its scroll behind it. Opening and closing keep the card being read where it was (`viewportAnchor`).
- **How to open it.** An **Asistente** button in the header and a floating one at the bottom right. On a phone the floating button sits above the height of a stuck decision bar (`--tap`, its padding and the bottom safe area), so it can never cover accept or reject; `main` gets the matching bottom padding. After the first scroll down it shrinks to a round 44 px icon; its accessible name stays **Asistente** and focus shows the label again. Escape, the ✕ and the scrim close the panel and return focus to the button that opened it.
- **Order inside.** Header (title, a state word, **Ajustes** while ChatGPT is connected, close), the settings section when open, the context chips (the book selected in the page, and the item being asked about, removable), a muted line with both accounts (**RE;write: sesión iniciada**, **ChatGPT: sin conectar** or **conectado**), the conversation (`role="log"`), the prompt (`--text-md`, Enter sends, Shift+Enter breaks the line; **Detener** replaces **Enviar** while a turn runs), then a small muted footer saying the conversation is kept only in this tab.
- **Settings** are a section of the panel under its header (`#assistant-settings`, `aria-label="Ajustes del asistente"`), never a dialog; **Ajustes** is a toggle with `aria-expanded` and looks pressed while open. On a `--pressed` background: **Modelo** (the account's models, with the provider's names and order), **Razonamiento** (**Rápido**, **Equilibrado**, **A fondo**; disabled, with a muted line saying why, for a model without reasoning), then **Nueva conversación** and **Desconectar ChatGPT** (`reject`). Both fields are full-width page controls (16 px, 44 px high). A saved choice says **Se usará en tu próximo mensaje.**; a refused one shows the fixed message of its code. The section is rebuilt only when the settings change, never on a streamed delta, so an open list keeps its focus. It scrolls on its own above 60% of the panel.
- **Transcript.** What the writer saw is kept per person (a hash of the session's subject) and per book in the tab's `sessionStorage` and shown again after a reload; another person in the same tab never sees it. When the engine no longer holds that conversation, one dashed line says **El asistente ya no recuerda los mensajes anteriores.** with **Nueva conversación** beside it.
- **States** have a word, and a dot only repeats it: *Sin conectar*, *Esperando el código*, *Conectando…*, *Conectado*, *Pensando…*, *Escribiendo…*, *Detenida*, *Error*. The device login, its code and the OpenAI link are shown inside the conversation area. Before the code, a not-connected panel says **Qué necesitas** in two short sentences (the RE;write account is enough for books, imports and review; the assistant also needs the writer's own ChatGPT, connected with a code at OpenAI, never a password here), then **Conectar ChatGPT**, then muted notes on what the assistant may do and on the ChatGPT connector as another way in. Errors are `role="alert"` with the fixed Spanish message of their code.
- **Answers** are prose (`--font-prose`): paragraphs, lists, quotes, `strong`, `em` and inline `code`, built as elements from the text. Nothing from the model becomes markup.
- **Tool steps** are chips above the answer, muted, with a spinner while they run (`Leyendo escena 3…`), a tick when done (`Leída: escena 3`, `Propuestos 2 hallazgos`) and `--reject` with a "!" and the word *Error* when they fail. What the assistant created is a `--accept-bg` line with **Ver en la página**, which unfolds the section, scrolls the card to the centre, focuses it and outlines it (`.flash`) for two seconds.
- **Empty state.** One sentence on what the assistant may do, and a few quick questions as full-width rounded buttons. They only fill the prompt; **Analiza esta escena** appears only while a scene is open and sets it as the item.
- **Preguntar al asistente** is a quiet text button at the top right of each proposal, finding and claim card, never inside the sticky decision bar.

## Motion

Only short state transitions (120 ms) on controls and on the fold chevron, and the spinner of a running
assistant step. `prefers-reduced-motion` removes them and turns smooth scrolling into a jump (`scrollBehavior()` in the script).
