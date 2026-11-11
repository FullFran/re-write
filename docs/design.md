# Design rules for the web pages

The rules the review page (`src/adapters/review-page.ts`) follows. A new page should
follow them too, and reuse the custom properties instead of new literals. The pages
are tools for reading prose and deciding on it: restraint comes before decoration.

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

## Layout and breakpoints

- Base styles are fluid and already work on a phone. Two breakpoints only:
  `max-width: 40em` (phone: full-width controls, sticky decision bar) and
  `min-width: 48em` (more padding).
- Nothing scrolls sideways: `overflow-wrap: anywhere` on `body`, `pre-wrap` for
  diffs and code, `min-width: 0` on flexible controls.
- `viewport-fit=cover` is set, so the page pads itself with `env(safe-area-inset-*)`
  (`--gutter` for the sides, the header for the top, the decision bar and `main` for the bottom).
- Zooming is never disabled.

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

- An error is `role="alert"`; the newest one stays at the top of the screen.
- News that cannot be shown yet is a floating `role="status"` box (`.notice`). It is in
  the page from the start, empty, and gets its text when there is news, so screen
  readers announce it. Do not add a permanent `role="dialog"` or `aria-modal`
  element: the review page pauses its refresh while one exists.

## Motion

Only short state transitions (120 ms) on controls. `prefers-reduced-motion` removes
them and turns smooth scrolling into a jump (`scrollBehavior()` in the script).
