import type { Locator, Page, TestInfo } from '@playwright/test';
import { expect, test, type Book } from '../fixtures.ts';

// Taking a decision back (#98), through the real page and the real server: undo on the card,
// revert of an applied change through an inverse proposal, and a tab that saw an older state.

const SCENE = 'scenes/escena-01.md';
const SENTENCE = 'Fuera empezaba a llover';
const CHANGE = 'Fuera arreciaba la tormenta';
const STALE = 'Esta decisión cambió en otra pestaña. Recarga para ver el estado actual.';

function propose(book: Book, replace = CHANGE, find = SENTENCE): string {
  return book.cli('propose', '--file', SCENE, '--find', find, '--replace', replace, '--rationale', 'Una imagen más intensa').proposal.proposal_id;
}

async function open(page: Page, book: Book): Promise<void> {
  await page.goto(`${book.base}/review`);
  await expect(page.getByRole('navigation', { name: 'Secciones' })).toBeVisible();
}

const proposalIn = (page: Page, section: string, book: Book, id: string) =>
  page.locator(`#sec-${section} article[id$="proposal-${book.book}-${id}"]`);

/** Saved with the run's results, so the layout can be looked at without running anything. */
async function shot(target: Locator, info: TestInfo, name: string): Promise<void> {
  await target.screenshot({ path: info.outputPath(name + '.png') });
}

test('rechazar -> deshacer -> aceptar: the same card takes the decision back and decides again', async ({ page, book }, info) => {
  const id = propose(book);
  const before = book.bytes(SCENE);
  await open(page, book);

  const card = proposalIn(page, 'cambios', book, id);
  await card.getByRole('button', { name: 'Rechazar' }).click();
  await expect(card.locator('.state-badge')).toHaveText('Rechazada');
  await expect(card).toContainText('Decisión guardada');
  await shot(card, info, 'card-after-decision-desktop');

  await card.getByRole('button', { name: 'Deshacer decisión editorial' }).click();
  await expect(card.locator('.state-badge')).toHaveText('Pendiente');
  await expect(card).toContainText('Reabierta por');
  expect(book.bytes(SCENE).equals(before)).toBe(true);
  expect(book.cli('show', id).proposal.status).toBe('proposed');

  await card.getByRole('button', { name: 'Aceptar cambio' }).click();
  await expect(card.locator('.state-badge')).toHaveText('Aceptada');
  expect(book.bytes(SCENE).toString('utf8')).toContain(CHANGE);
  expect(book.cli('show', id).proposal.history.map((e: any) => e.to)).toEqual(['rejected', 'proposed', 'accepted']);
});

test('aceptar -> revertir -> aceptar la inversa puts the scene bytes back exactly', async ({ page, book }, info) => {
  const before = book.bytes(SCENE);
  const id = propose(book);
  await open(page, book);

  await proposalIn(page, 'cambios', book, id).getByRole('button', { name: 'Aceptar cambio' }).click();
  await expect(proposalIn(page, 'cambios', book, id).locator('.state-badge')).toHaveText('Aceptada');
  const accepted = book.bytes(SCENE);
  expect(accepted.equals(before)).toBe(false);

  await page.reload();
  const original = proposalIn(page, 'historial', book, id);
  await original.getByRole('button', { name: 'Revertir cambio de texto' }).click();
  const confirm = original.getByRole('dialog', { name: 'Revertir cambio de texto' });
  await expect(confirm).toContainText('El texto no cambia hasta que una persona la acepte');
  await shot(original, info, 'revert-confirmation-desktop');
  await confirm.getByRole('button', { name: 'Crear propuesta inversa' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect(book.bytes(SCENE).equals(accepted)).toBe(true);

  const inverseId = book.cli('show', id).proposal.history.at(-1).ref;
  const inverse = proposalIn(page, 'cambios', book, inverseId);
  await expect(inverse).toContainText('Revierte el cambio aceptado');
  await expect(inverse).toBeFocused();
  await inverse.getByRole('button', { name: 'Aceptar cambio' }).click();
  await expect(inverse.locator('.state-badge')).toHaveText('Aceptada');
  expect(book.bytes(SCENE).equals(before)).toBe(true);

  await page.reload();
  const history = page.locator('#sec-historial');
  await expect(proposalIn(page, 'historial', book, id).locator('.decision-log li')).toHaveText([/^Aceptada por /, /^Reversión pedida por .* propuesta inversa /]);
  await shot(history, info, 'historial-desktop');
  await proposalIn(page, 'historial', book, id).getByRole('button', { name: 'Volver a proponer' }).click();
  await expect(page.locator('#sec-cambios article', { hasText: 'Vuelve a proponer el cambio' })).toContainText(CHANGE);
  expect(book.bytes(SCENE).equals(before)).toBe(true);
});

test('a tab opened before another tab took a decision back cannot decide on what it saw', async ({ page, book, context }) => {
  const id = propose(book);
  await open(page, book);
  const other = await context.newPage();
  await open(other, book);
  await proposalIn(other, 'cambios', book, id).getByRole('button', { name: 'Rechazar' }).click();
  await proposalIn(other, 'cambios', book, id).getByRole('button', { name: 'Deshacer decisión editorial' }).click();
  await expect(proposalIn(other, 'cambios', book, id).locator('.state-badge')).toHaveText('Pendiente');
  const before = book.bytes(SCENE);
  const head = book.git('rev-parse', 'HEAD');

  // The first tab still shows the proposal as never decided; the background refresh has not run.
  await proposalIn(page, 'cambios', book, id).getByRole('button', { name: 'Aceptar cambio' }).click();
  const alert = page.getByRole('alert');
  await expect(alert).toContainText(STALE);
  expect(book.bytes(SCENE).equals(before)).toBe(true);
  expect(book.git('rev-parse', 'HEAD')).toBe(head);

  await alert.getByRole('button', { name: 'Recargar' }).click();
  await expect(page.getByRole('alert')).toHaveCount(0);
  await expect(proposalIn(page, 'cambios', book, id)).toContainText('Reabierta por');
  await proposalIn(page, 'cambios', book, id).getByRole('button', { name: 'Aceptar cambio' }).click();
  await expect(proposalIn(page, 'cambios', book, id).locator('.state-badge')).toHaveText('Aceptada');
});

test.describe('on a phone', () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

  test('the saved decision and Historial fit the screen', async ({ page, book }, info) => {
    const rejected = propose(book, 'El guardia calló', 'El guardia no preguntó');
    book.cli('review-proposal', rejected, 'reject');
    const id = propose(book);
    await open(page, book);

    const card = proposalIn(page, 'cambios', book, id);
    await card.getByRole('button', { name: 'Aceptar cambio' }).click();
    await expect(card).toContainText('Decisión guardada');
    await expect(card.getByRole('button', { name: 'Revertir cambio de texto' })).toBeInViewport();
    await shot(card, info, 'card-after-decision-phone');

    await page.getByRole('link', { name: /Historial de cambios del manuscrito/ }).click();
    await expect(proposalIn(page, 'historial', book, rejected).getByRole('button', { name: 'Deshacer decisión editorial' })).toBeVisible();
    await shot(page.locator('#sec-historial'), info, 'historial-phone');
    const { scrollWidth, clientWidth } = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
    }));
    expect(scrollWidth).toBeLessThanOrEqual(clientWidth);
  });
});
