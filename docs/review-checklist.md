# Manual Review Checklist

This checklist guides manual verification of the human review workflow on the real `/review` page using a synthetic book. Follow these steps to ensure proposals can be reviewed, accepted, or rejected safely without losing manuscript history.

Target domain: `https://rewrite.fullfran.com`

Items marked *(automated)* are checked on every pull request by the browser tests (`browser-tests/`, see [testing](testing.md)), which drive this page in headless Chromium against the real server and a synthetic book. They are still worth a look on a release, since the tests run without the real Clerk.

---

## 1. Sign In

- [ ] Navigate in a modern desktop browser to `https://rewrite.fullfran.com/review`.
- [ ] Confirm you are presented with the secure sign-in card.
- [ ] Sign in with test reviewer credentials assigned to the synthetic book.
- [ ] Confirm the top bar renders the application header and account button, and the synthetic book selector appears.

## 2. Inspect a Pending Proposal and Diff

- [ ] Select the synthetic book from the book dropdown selector.
- [ ] With two books, select the one that is not first. Accept or reject a change, import a scene, wait for a refresh, reload, and open `/review/engine`: the same book stays selected each time and the address shows `?book=<id>`. *(automated)*
- [ ] Open `/review?book=<an id you cannot open>`: one line says the book is not available before another one shows.
- [ ] Under the **Cambios propuestos** (Proposed changes) section, locate an active proposal card.
- [ ] Confirm the card displays:
  - The editorial rationale explaining why the change was proposed.
  - A visual diff with **− Eliminado:** and struck-through removed text, plus **+ Añadido:** and underlined added text. Check light and dark themes.
  - **Ver diff unificado (texto)** expands the exact base-to-proposed unified diff (`---` / `+++`) for reading and copying.
  - A visible **Pendiente** badge.
- [ ] Confirm two action buttons are available on applicable proposals:
  - **Aceptar cambio** (Accept change)
  - **Rechazar** (Reject)

## 3. Reject a Proposal

- [ ] Choose a proposal intended for rejection.
- [ ] Click **Rechazar**. *(automated)*
- [ ] Confirm the card remains where you acted, now with the **Rechazada** badge and no decision buttons. *(automated)*
- [ ] Reload the page and scroll to **Historial de cambios del manuscrito** (Manuscript change history). *(automated)*
- [ ] Confirm the rejected proposal is listed with the **Rechazada** badge. *(automated)*
- [ ] Confirm the original scene text remains byte-identical and unmodified. *(automated)*

## 4. Accept a Proposal

- [ ] Choose a valid pending proposal that you wish to incorporate.
- [ ] Click **Aceptar cambio**. *(automated)*
- [ ] Confirm the card remains where you acted, now with the **Aceptada** badge and no decision buttons. *(automated)*
- [ ] Reload the page and scroll to **Historial de cambios del manuscrito**. *(automated)*
- [ ] Confirm the proposal appears with the **Aceptada** badge and displays the version commit hash (e.g., `versión a1b2c3d4e5`). *(automated)*

## 5. Confirm History and Audit Trail

- [ ] In the **Historial de cambios del manuscrito** section, verify each decided proposal displays its outcome (**Aceptada** or **Rechazada**). *(automated)*
- [ ] Confirm the previous manuscript text is preserved in repository history: an accepted change creates a new commit while prior commits remain intact. *(automated)*
- [ ] Confirm **Canon** explains that only human-accepted narrated facts with valid evidence belong there; accepting manuscript text does not approve claims. *(automated)*
- [ ] Confirm proposed claims show **Pendiente** and do not enter **Canon**. *(automated)*
- [ ] Confirm accepted rumors/beliefs and claims with stale evidence appear under **Afirmaciones fuera del Canon**, each with a reason.
- [ ] Confirm rejected claims remain visible under **Afirmaciones rechazadas** with **Rechazada** badges.

## 6. Verify Stale Proposal Handling

- [ ] Locate a proposal whose base scene text was changed by an earlier accepted proposal or edited in the source. *(automated)*
- [ ] Confirm the proposal card displays the warning message *(automated)*:
  > **No aplicable: la escena ha cambiado**
  > *"La escena ha cambiado desde esta propuesta: ya no se puede aplicar."*
- [ ] Confirm the **Aceptar cambio** button is hidden or prevented from applying. *(automated)*
- [ ] Confirm the reviewer can safely dismiss the stale proposal by clicking **Rechazar**. *(automated)*
- [ ] Confirm clicking **Rechazar** preserves the source text without alteration and records the rejection in the change history. *(automated)*


## 7. Review Notes Without Data Loss

- [ ] On a narrative finding, confirm the note counter shows **0 / 2000 caracteres** and updates while typing.
- [ ] Submit a 2,000-character note and confirm it is retained in full after reloading.
- [ ] Enter or paste 2,001 characters. Confirm the text is not cut and submitting reports **La nota supera el límite de 2000 caracteres.** without recording a rating.
- [ ] Repeat proposal accept/reject inside the scene viewer: the scene stays open and the acted-on card shows its new Spanish state.

## 8. Live Refresh Without a Reload

The page asks for the review queue again every 5 seconds while its tab is visible; an unchanged queue is answered with `304 Not Modified`.

- [ ] Keep the page open and create a proposal for the synthetic book from a connected assistant (or the CLI). Confirm it appears under **Cambios propuestos** within a few seconds, without reloading and without the page scrolling away from what you were reading.
- [ ] Open a scene with two pending proposals on the same passage. In a second tab, accept one. Confirm that in the first tab, without reloading, the other card shows **No aplicable: la escena ha cambiado**, loses **Aceptar cambio**, and the accepted one appears under **Historial de cambios del manuscrito**.
- [ ] Type a note on a narrative finding and do not submit it. Change the queue from the second tab. Confirm the note is intact, the queue did not change under you, and the page says **Hay novedades en este libro…**. Submit or clear the note and confirm the news appears.
- [ ] Open the account menu (top right) and change the queue from the second tab. Confirm the page waits until the menu is closed, then refreshes.
- [ ] With the browser's network panel open, switch to another tab for a minute. Confirm no request to `/review/api/books/{book}` was made while hidden, and that one is made as soon as you return.

## 8b. Assistant Panel (engine enabled)

With `REWRITE_ENGINE=1` the review page carries the assistant panel. Rules: `docs/design.md`, "Assistant panel"; server side: `docs/engine.md`.

- [ ] On a phone, scroll to a pending proposal until its **Aceptar cambio** bar sticks to the bottom. Confirm the round **Asistente** button floats above the bar and never covers it, and that it shows its label again at the top of the page.
- [ ] Open the panel, type a question and close it without sending. Confirm the page did not move, and that reopening shows the text still there.
- [ ] Not connected: before any code the panel shows **RE;write: sesión iniciada**, **ChatGPT: sin conectar** and **Qué necesitas** (the RE;write account is enough for books, imports and review; the assistant also needs your own ChatGPT, connected with a code at OpenAI; the connector is another way in), then **Conectar ChatGPT**; after pressing it, a code, **Abrir OpenAI** and **Esperando a que confirmes en OpenAI…**. After approving at OpenAI, the panel switches to the quick actions by itself and shows **ChatGPT: conectado**. *(automated)*
- [ ] Ask **Busca incoherencias en el libro**. While it works, steps such as **Leyendo escena 3…** appear and turn into **Leída: escena 3**; the answer streams with paragraphs and lists. Text with `<b>` or `<img>` from a manuscript shows as text.
- [ ] Ask it to propose a finding. Confirm the panel says the result will appear, then shows **1 hallazgo nuevo** with **Ver en la página**, which scrolls to the new card and outlines it.
- [ ] On a proposal, press **Preguntar al asistente**. The panel opens with a draft question and a **Cambio propuesto · …** reference that can be removed with ✕. The answer is about that proposal without naming it.
- [ ] Keep the panel's field focused while the queue changes in another tab: the page still refreshes. Focus a note field in the page instead: the page waits, as in section 8.
- [ ] Open `/review/engine`: it lands on `/review` with the panel open.
- [ ] On a desktop, open the panel: the page column moves aside and stays usable; the section list moves to the top row.

## 9. Phone Layout

Automated tests pin the stylesheet's tokens and rules (`tests/review-mobile.test.ts`) but cannot see a layout. Check these on a real phone, or in a browser's device mode at 360 px wide, in light and dark. The rules behind them are in `docs/design.md`.

- [ ] Nothing scrolls sideways in any state: empty book, a long diff, a proposal or quote with a very long word or URL, the Notion mapping form, an error, the **Hay novedades en este libro…** notice. *(automated at 390 px for a book with pending work and a long URL in a rationale; the other states stay manual)*
- [ ] Focusing the note field or **Título del libro** does not zoom the page (iOS Safari).
- [ ] While reading a long proposal under **Cambios propuestos**, **Aceptar cambio** and **Rechazar** stay at the bottom of the screen, clearly apart, and the text scrolls out from under the bar instead of staying hidden. The bar belongs to the card on screen: it does not appear for the next card until that card's badge and rationale are visible.
- [ ] On a phone with a home indicator, the bar's buttons are not under it; in landscape, no text sits under the notch.
- [ ] Removed and added passages are told apart by their labels and by strike-through and underline, not only by colour.
- [ ] Trigger an error far down the page (for example a note over the limit): the message is visible at the top of the screen without scrolling.
- [ ] With the keyboard only, every control shows a focus outline, and Enter or Space on a finding's quote opens its scene.
- [ ] With "reduce motion" enabled in the system, opening a scene jumps instead of scrolling smoothly.
- [ ] At 1280 px wide the page is one centred column of readable width, not full-width lines.

## 10. Section Navigation and Folding

Tests pin the order, the landmark, the counts and the fold state (`tests/review-mobile.test.ts`, `tests/review-refresh.test.ts`); what the bar covers and how it scrolls is checked here.

- [ ] On a phone, the first pending proposal under **Cambios propuestos** is on the first screen, above both import forms. *(automated)*
- [ ] The row of section links stays at the top of the screen while scrolling and scrolls sideways with one thumb; the page itself never scrolls sideways. A number beside a link is the count of items waiting there.
- [ ] While reading a long proposal, the navigation row is at the top and **Aceptar cambio** / **Rechazar** are at the bottom: neither covers the other, in portrait or landscape.
- [ ] Tap **Historial**: the section opens and its heading lands just below the row, not under it. The link is shown as current, and it changes as you scroll through the sections.
- [ ] On a phone, **Importar escenas Markdown**, **Importar desde Notion**, **Navegar escenas**, **Canon** and **Historial de cambios del manuscrito** start folded when they have content; each heading opens and closes its section. A book without scenes shows the Markdown import form open.
- [ ] A section with nothing in it shows its heading and one line (for example **Ningún cambio pendiente.**).
- [ ] Tap a finding's quote while **Navegar escenas** is folded: the scene list opens and the scene is shown with the quote highlighted.
- [ ] Fold a section, then change the queue from a second tab: after the refresh the section is still folded, the counts in the row are updated and the page has not moved.
- [ ] Choose a file in a folded import form's section, fold it and change the queue from a second tab: the page waits and shows **Hay novedades en este libro…** below the row.
- [ ] With the keyboard only: Tab reaches the row, Enter on a link moves focus to that section's heading, and Enter or Space on a heading folds it. A screen reader announces the row as the navigation **Secciones** and the current link as current.
- [ ] Trigger an error while scrolled down: the message appears below the navigation row, not over it.
- [ ] At 1280 px wide the links are a list to the left of the column that stays in place while scrolling and covers no text; at 768 px they are the row at the top.
- [ ] **Crear otro libro** opens and closes its form every time it is clicked.
