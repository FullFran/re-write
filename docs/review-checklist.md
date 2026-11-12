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
- [ ] Confirm the card remains where you acted, now with the **Rechazada** badge, no decision buttons, and **Decisión guardada · Deshacer**. *(automated)*
- [ ] Reload the page and scroll to **Historial de cambios del manuscrito** (Manuscript change history). *(automated)*
- [ ] Confirm the rejected proposal is listed with the **Rechazada** badge. *(automated)*
- [ ] Confirm the original scene text remains byte-identical and unmodified. *(automated)*

## 4. Accept a Proposal

- [ ] Choose a valid pending proposal that you wish to incorporate.
- [ ] Click **Aceptar cambio**. *(automated)*
- [ ] Confirm the card remains where you acted, now with the **Aceptada** badge, no decision buttons, and **Decisión guardada · Deshacer**. *(automated)*
- [ ] Reload the page and scroll to **Historial de cambios del manuscrito**. *(automated)*
- [ ] Confirm the proposal appears with the **Aceptada** badge and displays the version commit hash (e.g., `versión a1b2c3d4e5`). *(automated)*

## 5. Confirm History and Audit Trail

- [ ] In the **Historial de cambios del manuscrito** section, verify each decided proposal displays its outcome (**Aceptada** or **Rechazada**). *(automated)*
- [ ] Confirm the previous manuscript text is preserved in repository history: an accepted change creates a new commit while prior commits remain intact. *(automated)*
- [ ] Confirm **Canon** explains that only human-accepted narrated facts with valid evidence belong there; accepting manuscript text does not approve claims. *(automated)*
- [ ] Confirm proposed claims show **Pendiente** and do not enter **Canon**. *(automated)*
- [ ] Confirm accepted rumors/beliefs and claims with stale evidence appear under **Afirmaciones fuera del Canon**, each with a reason.
- [ ] Confirm rejected claims remain visible under **Afirmaciones rechazadas** with **Rechazada** badges.

## 5b. Take a Decision Back (#98)

- [ ] Reject a proposal, click **Deshacer** on the same card: it is **Pendiente** again with **Aceptar cambio** and **Rechazar**, its history reads "Rechazada por … · Reabierta por …", and the scene text is unchanged. Accept it. *(automated)*
- [ ] Accept a proposal, then click **Deshacer** (or **Volver a revisar** in Historial): a box titled **Revertir cambio de texto** explains that an inverse proposal is created and the text does not change until a person accepts it. **Cancelar** closes it and writes nothing. *(automated)*
- [ ] Click **Crear propuesta inversa**: focus moves to the inverse proposal in **Cambios propuestos** ("Revierte el cambio aceptado P-…", with a link). Accept it and confirm the scene bytes are back exactly. *(automated)*
- [ ] In Historial, the original change lists "Aceptada por … · Reversión pedida por … · propuesta inversa Q-…" with links, and offers **Volver a proponer**, which creates a pending proposal "Vuelve a proponer el cambio P-…". *(automated)*
- [ ] After a reload, every decided item in Historial still offers **Volver a revisar** (state is on the server). *(automated)*
- [ ] On an accepted or rejected claim, and on a rated finding, **Deshacer decisión editorial** makes it pending again; a reopened claim leaves Canon, a reopened finding shows "Valoración reabierta" with the earlier verdict. *(automated, claims and narrative findings)*
- [ ] Accept a narrated fact, move its sentence elsewhere in the scene, and undo the decision: the card shows "Cita anterior", the suggested passage and **Aceptar pasaje sugerido**, and no **Aceptar**. Accept the passage: the history reads "Nuevo anclaje aceptado por …", the scene is unchanged, and the claim can be accepted into Canon. With the sentence deleted instead, the card says "No se encontró un pasaje parecido en la escena actual." *(automated; screenshots on desktop and phone in the browser job's results)*
- [ ] Open the same book in two tabs. In one, reject and undo a proposal; in the other, accept it: the second tab shows "Esta decisión cambió en otra pestaña. Recarga para ver el estado actual." with **Recargar**, and nothing is written. *(automated)*
- [ ] With the revert box open, wait for a background refresh: the box stays open (the notice shows instead). *(automated)*
- [ ] On a phone, the saved-decision line and Historial fit the screen with no sideways scroll. *(automated; screenshots in the browser job's results)*

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
- [ ] Scene editor on a real iPhone (Safari) and a real Android phone (Chrome, Gboard): open **Editar escena** and in **Vista previa en vivo** type with autocorrect, an accented letter held down, and dictation; the page does not zoom, the cursor stays where the text goes, and **Guardar** saves exactly what is shown (compare in **Markdown**). *(Chromium mobile emulation and an IME composition are automated in `browser-tests/tests/scene-editor.spec.ts`; real devices are not)*
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

## 11. Edit a Scene

Tests pin the save path, the conflict refusal, the draft and the refresh that leaves the editor alone (`tests/scene-edit.test.ts`, `tests/scene-editor-page.test.ts`, `tests/review-modes.test.ts`); typing on real keyboards is checked here.

- [ ] Open a scene under **Navegar escenas** and press **Editar escena**: the page switches to **Concentración** and the field shows the scene's Markdown with its marks. **Cerrar editor** comes back to **Revisión** at that scene. *(automated)*
- [ ] Type with accents, dialogue dashes and a dictated or autocorrected word on a phone keyboard; press **Guardar**: the status says **Guardado** and, after a reload, the scene shows exactly what was typed.
- [ ] Ctrl+S (Cmd+S on a Mac) in the field saves instead of opening the browser's save dialog.
- [ ] Open the same scene in two tabs, save in one, then save in the other: the second shows **No se guardó: la escena cambió mientras editabas** with both versions, and keeps its text. *(automated)*
- [ ] While a scene is open in the editor, accept a proposal for it from a second tab: the editor is not replaced, within a few seconds the desk says **Esta escena ha cambiado fuera de este editor.**, and saving shows the conflict. *(automated)*
- [ ] After saving an edit, a pending proposal for that scene shows **No aplicable: la escena ha cambiado** and offers no accept. *(automated)*
- [ ] Type without saving and reload the tab: reopening the editor recovers the text. Close the tab and open the page again: the text is gone.
- [ ] Try to leave the page with unsaved text: the browser asks first.
- [ ] With a screen reader, the field is announced with the scene's name and the save status is read when it changes.

## 12. Modes: Concentración, Ayuda RE;write, Revisión

Tests pin the remembered mode, the kept editor, the scene's items, quote selection and the dock (`tests/review-modes.test.ts`, `browser-tests/tests/modes.spec.ts`, which also saves screenshots of both writing modes, light and dark, on desktop and on a phone). Real devices and the feel of writing are checked here.

- [ ] A new account opens in **Revisión**, with every section as before. Choose **Concentración** and reload: the page opens in **Concentración** at the same scene.
- [ ] In **Concentración** only the book, the mode switch, the scene picker, the scene's title and word count, **Guardar** with its status and the editor are on screen. No proposal, finding or claim appears, the assistant does not open by itself and its button is outlined, not filled.
- [ ] Type in the middle of a paragraph without saving, then switch to **Ayuda RE;write**, **Revisión** and back with a thumb on a real phone: the text and the caret are where they were, and the keyboard did not have to be reopened twice.
- [ ] In **Ayuda RE;write** on a computer the help column is on the right of the text and lists only the open scene's changes, findings, possible problems and claims, each with its usual actions. On a phone **Texto** and **Ayuda (n)** swap the two.
- [ ] Tap a quote in the help: the editor shows the scene with those words selected and in view. Rewrite those words and tap again: the help says the quote is no longer in the text.
- [ ] Accept or reject from the help column: the decision is taken, the card says **Decisión guardada · Deshacer**, and the editor keeps its text and its unsaved changes.
- [ ] **‹** and **›** and the scene list open the neighbouring scenes; unsaved text of the scene left is offered again when coming back.
- [ ] On a phone the switch sits at the bottom above the home indicator, each button is a full thumb target, and the accept and reject bar and the assistant button stop above it. Nothing scrolls sideways.
- [ ] With the keyboard only: Tab reaches the switch, Enter or Space changes the mode, and a screen reader announces the group **Modo** and which mode is pressed.

## 13. Notes, Wikilinks and the Graph List

Tests pin link rendering, completion, following a link, backlinks, the note save and the graph table (`editor/test/wikilinks.test.mjs`, `editor/test/graph-analysis.test.mjs`, `tests/book-graph-http.test.ts`, `browser-tests/tests/notes-graph.spec.ts` and `graph-view.spec.ts`, which also save screenshots on desktop and on a phone). Real keyboards and screen readers are checked here.

- [ ] In **Vista previa en vivo**, a line with `[[Elena|la capitana]]` reads **la capitana**, underlined; moving the cursor onto the line shows the brackets. A link to a note that does not exist is grey and dashed. *(automated)*
- [ ] Type `[[` and a few letters of a note or an alias, without accents or capitals, on a phone keyboard: the list offers it; choosing it closes the link. Dictation and autocorrect after the link still work.
- [ ] Tap a link shown as text on a phone: its note opens in the editor. With a keyboard, Enter with the cursor inside a link does the same. *(automated)*
- [ ] **Notas** in **Concentración** and in **Ayuda RE;write** lists the notes by type; a note opens, saves with **Guardar** and shows **Menciones enlazadas** and **Menciones sin enlazar**; a mention opens its scene with the words selected. *(automated)*
- [ ] **Grafo** shows the table; with a screen reader, sorting by a header announces the order, the arrows move between nodes, and choosing one reads **Elegido: …**.
- [ ] **Hasta la escena** at an earlier scene removes the later scenes from the table and the drawing and lowers the counts; a screen reader reads the slider as "N de M: <escena>". *(automated)*
- [ ] **Dibujo** on a desktop: the drawing appears with communities in colour; on a real phone (iOS Safari, Android Chrome) one finger pans the drawing, two fingers zoom, a tap on a node chooses its row, and the page still scrolls outside the drawing.
- [ ] **Análisis**: **Buscar camino** between two notes draws the path and the screen reader reads the steps; **Quitar camino** clears it; a ranking name chooses the node in the table. *(automated)*
- [ ] Switch the system theme while the drawing is open: labels, edges and colours follow at once and stay readable.

## 14. Formatting, Analizar and the Phone Keyboard (#101)

Tests pin every formatting rule on the raw Markdown (`editor/test/format.test.mjs`), the scope line and the engine-off message of **Analizar** (`tests/review-modes.test.ts`), and in Chromium the saved bytes of each toolbar action, Ctrl+B/I, the scope and the one prompt sent with the scene as context, and the phone layout at 360x740 and 390x844 with a simulated keyboard (`browser-tests/tests/format-toolbar.spec.ts` and `analyse.spec.ts`, which save screenshots on desktop and on a phone, light and dark). Emulation shrinks the whole window; a real on-screen keyboard only shrinks the visual viewport and behaves differently per browser. These need a real device:

- [ ] iOS Safari and Android Chrome (Gboard): open the keyboard in **Concentración** and type at the end of a long scene. The line being typed stays above the keyboard, **Guardar** and its status stay at the top of what is visible, and the mode dock is gone until the keyboard closes.
- [ ] iOS Safari: scroll up and down with the keyboard open. The head with **Guardar** follows the visible top (`--vv-top`) without jumping, and nothing is left floating in the middle of the screen when the keyboard closes.
- [ ] On a real phone, select a word with a long press and tap **Formato**, then **Negrita**: the selection survives the tap, the word becomes `**word**` in **Markdown**, and the system selection handles do not cover the toolbar.
- [ ] Hold a key for an accented letter and dictate a sentence right after **Cursiva** at the cursor: the text lands between the markers and the composition is not cut.
- [ ] Rotate the phone with the keyboard open and closed: the dock comes back when the keyboard closes; nothing scrolls sideways.
- [ ] Safe areas on a phone with a notch and a home indicator, in both orientations: the dock, the toolbar and the scene list stay inside them.
- [ ] Mac: Cmd+B and Cmd+I format (the tests use Ctrl on Linux).
- [ ] With a screen reader: the **Formato** group, each button's name and pressed state, **Analizar** with `aria-expanded`, the **Qué analizar** group and the **Se analizará: …** line are announced.
- [ ] **Analizar** with a real ChatGPT account: the answer names the scene or the selection asked about; for **El libro** it says which scenes it read.
