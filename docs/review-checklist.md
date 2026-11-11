# Manual Review Checklist

This checklist guides manual verification of the human review workflow on the real `/review` page using a synthetic book. Follow these steps to ensure proposals can be reviewed, accepted, or rejected safely without losing manuscript history.

Target domain: `https://rewrite.fullfran.com`

---

## 1. Sign In

- [ ] Navigate in a modern desktop browser to `https://rewrite.fullfran.com/review`.
- [ ] Confirm you are presented with the secure sign-in card.
- [ ] Sign in with test reviewer credentials assigned to the synthetic book.
- [ ] Confirm the top bar renders the application header and account button, and the synthetic book selector appears.

## 2. Inspect a Pending Proposal and Diff

- [ ] Select the synthetic book from the book dropdown selector.
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
- [ ] Click **Rechazar**.
- [ ] Confirm the card remains where you acted, now with the **Rechazada** badge and no decision buttons.
- [ ] Reload the page and scroll to **Historial de cambios del manuscrito** (Manuscript change history).
- [ ] Confirm the rejected proposal is listed with the **Rechazada** badge.
- [ ] Confirm the original scene text remains byte-identical and unmodified.

## 4. Accept a Proposal

- [ ] Choose a valid pending proposal that you wish to incorporate.
- [ ] Click **Aceptar cambio**.
- [ ] Confirm the card remains where you acted, now with the **Aceptada** badge and no decision buttons.
- [ ] Reload the page and scroll to **Historial de cambios del manuscrito**.
- [ ] Confirm the proposal appears with the **Aceptada** badge and displays the version commit hash (e.g., `versión a1b2c3d4e5`).

## 5. Confirm History and Audit Trail

- [ ] In the **Historial de cambios del manuscrito** section, verify each decided proposal displays its outcome (**Aceptada** or **Rechazada**).
- [ ] Confirm the previous manuscript text is preserved in repository history: an accepted change creates a new commit while prior commits remain intact.
- [ ] Confirm **Canon** explains that only human-accepted narrated facts with valid evidence belong there; accepting manuscript text does not approve claims.
- [ ] Confirm proposed claims show **Pendiente** and do not enter **Canon**.
- [ ] Confirm accepted rumors/beliefs and claims with stale evidence appear under **Afirmaciones fuera del Canon**, each with a reason.
- [ ] Confirm rejected claims remain visible under **Afirmaciones rechazadas** with **Rechazada** badges.

## 6. Verify Stale Proposal Handling

- [ ] Locate a proposal whose base scene text was changed by an earlier accepted proposal or edited in the source.
- [ ] Confirm the proposal card displays the warning message:
  > **No aplicable: la escena ha cambiado**
  > *"La escena ha cambiado desde esta propuesta: ya no se puede aplicar."*
- [ ] Confirm the **Aceptar cambio** button is hidden or prevented from applying.
- [ ] Confirm the reviewer can safely dismiss the stale proposal by clicking **Rechazar**.
- [ ] Confirm clicking **Rechazar** preserves the source text without alteration and records the rejection in the change history.


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

## 9. Phone Layout

Automated tests pin the stylesheet's tokens and rules (`tests/review-mobile.test.ts`) but cannot see a layout. Check these on a real phone, or in a browser's device mode at 360 px wide, in light and dark. The rules behind them are in `docs/design.md`.

- [ ] Nothing scrolls sideways in any state: empty book, a long diff, a proposal or quote with a very long word or URL, the Notion mapping form, an error, the **Hay novedades en este libro…** notice.
- [ ] Focusing the note field or **Título del libro** does not zoom the page (iOS Safari).
- [ ] While reading a long proposal under **Cambios propuestos**, **Aceptar cambio** and **Rechazar** stay at the bottom of the screen, clearly apart, and the text scrolls out from under the bar instead of staying hidden. The bar belongs to the card on screen: it does not appear for the next card until that card's badge and rationale are visible.
- [ ] On a phone with a home indicator, the bar's buttons are not under it; in landscape, no text sits under the notch.
- [ ] Removed and added passages are told apart by their labels and by strike-through and underline, not only by colour.
- [ ] Trigger an error far down the page (for example a note over the limit): the message is visible at the top of the screen without scrolling.
- [ ] With the keyboard only, every control shows a focus outline, and Enter or Space on a finding's quote opens its scene.
- [ ] With "reduce motion" enabled in the system, opening a scene jumps instead of scrolling smoothly.
- [ ] At 1280 px wide the page is one centred column of readable width, not full-width lines.
