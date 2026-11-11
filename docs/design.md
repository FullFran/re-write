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

- Base styles are fluid and already work on a phone. Three breakpoints only:
  `max-width: 40em` (phone: full-width controls, sticky decision bar, tools and
  reference folded), `min-width: 48em` (more padding) and `min-width: 75em` (the
  section navigation moves beside the column).
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
  (`:focus-visible`).

## Messages

- An error is `role="alert"`; the newest one stays at the top of the screen, below
  the section navigation.
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
- **Order inside.** Header (title, a state word, close), the context chips (the book selected in the page, and the item being asked about, removable), a muted line with both accounts (**RE;write: sesión iniciada**, **ChatGPT: sin conectar** or **conectado**), the conversation (`role="log"`), the prompt (`--text-md`, Enter sends, Shift+Enter breaks the line; **Detener** replaces **Enviar** while a turn runs), then a small footer with **Desconectar ChatGPT**.
- **States** have a word, and a dot only repeats it: *Sin conectar*, *Esperando el código*, *Conectando…*, *Conectado*, *Pensando…*, *Escribiendo…*, *Detenida*, *Error*. The device login, its code and the OpenAI link are shown inside the conversation area. Before the code, a not-connected panel says **Qué necesitas** in two short sentences (the RE;write account is enough for books, imports and review; the assistant also needs the writer's own ChatGPT, connected with a code at OpenAI, never a password here), then **Conectar ChatGPT**, then muted notes on what the assistant may do and on the ChatGPT connector as another way in. Errors are `role="alert"` with the fixed Spanish message of their code.
- **Answers** are prose (`--font-prose`): paragraphs, lists, quotes, `strong`, `em` and inline `code`, built as elements from the text. Nothing from the model becomes markup.
- **Tool steps** are chips above the answer, muted, with a spinner while they run (`Leyendo escena 3…`), a tick when done (`Leída: escena 3`, `Propuestos 2 hallazgos`) and `--reject` with a "!" and the word *Error* when they fail. What the assistant created is a `--accept-bg` line with **Ver en la página**, which unfolds the section, scrolls the card to the centre, focuses it and outlines it (`.flash`) for two seconds.
- **Empty state.** One sentence on what the assistant may do, and a few quick questions as full-width rounded buttons. They only fill the prompt; **Analiza esta escena** appears only while a scene is open and sets it as the item.
- **Preguntar al asistente** is a quiet text button at the top right of each proposal, finding and claim card, never inside the sticky decision bar.

## Motion

Only short state transitions (120 ms) on controls and on the fold chevron, and the spinner of a running
assistant step. `prefers-reduced-motion` removes them and turns smooth scrolling into a jump (`scrollBehavior()` in the script).
