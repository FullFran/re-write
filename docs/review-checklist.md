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
  - A formatted diff block comparing the base scene text (`---`) with the proposed revision (`+++`).
- [ ] Confirm two action buttons are available on applicable proposals:
  - **Aceptar cambio** (Accept change)
  - **Rechazar** (Reject)

## 3. Reject a Proposal

- [ ] Choose a proposal intended for rejection.
- [ ] Click **Rechazar**.
- [ ] Confirm the proposal immediately leaves **Cambios propuestos**.
- [ ] Scroll to the **Historial de cambios** (Change history) section.
- [ ] Confirm the rejected proposal is listed with status `Estado: rejected`.
- [ ] Confirm the original scene text remains byte-identical and unmodified.

## 4. Accept a Proposal

- [ ] Choose a valid pending proposal that you wish to incorporate.
- [ ] Click **Aceptar cambio**.
- [ ] Confirm the proposal leaves **Cambios propuestos**.
- [ ] Scroll to the **Historial de cambios** section.
- [ ] Confirm the proposal appears with status `Estado: accepted` and displays the version commit hash (e.g., `versión a1b2c3d4e5`).

## 5. Confirm History and Audit Trail

- [ ] In the **Historial de cambios** section, verify each decided proposal displays its outcome (`accepted` or `rejected`).
- [ ] Confirm the previous manuscript text is preserved in repository history: an accepted change creates a new commit while prior commits remain intact.
- [ ] Confirm proposed claims that were not explicitly reviewed do not enter **Canon**.

## 6. Verify Stale Proposal Handling

- [ ] Locate a proposal whose base scene text was changed by an earlier accepted proposal or edited in the source.
- [ ] Confirm the proposal card displays the warning message:
  > *"La escena ha cambiado desde esta propuesta: ya no se puede aplicar."*
- [ ] Confirm the **Aceptar cambio** button is hidden or prevented from applying.
- [ ] Confirm the reviewer can safely dismiss the stale proposal by clicking **Rechazar**.
- [ ] Confirm clicking **Rechazar** preserves the source text without alteration and records the rejection in the change history.
