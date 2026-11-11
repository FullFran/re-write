import type { Page } from '@playwright/test';
import { expect, test, type Book } from '../fixtures.ts';

// Issue #103: the book the person chose stays chosen after an action and after a reload,
// even when it is not the first book of the list.

const SCENE = 'scenes/escena-01.md';

async function chooseSecondBook(page: Page, book: Book): Promise<string> {
  const id = book.cli('propose', '--file', SCENE, '--find', 'Fuera empezaba a llover', '--replace', 'Fuera arreciaba la tormenta', '--rationale', 'Una imagen más intensa').proposal.proposal_id;
  await page.goto(`${book.base}/review`);
  const picker = page.getByRole('combobox', { name: 'Libro' });
  await expect(picker).toHaveValue(book.book);

  // A second book whose id sorts first: the one the page used to fall back to.
  await page.getByRole('button', { name: 'Crear otro libro' }).click();
  await page.getByRole('textbox', { name: 'Título del libro' }).fill('Abril');
  await page.getByRole('button', { name: 'Crear libro' }).click();
  await expect(picker).toHaveValue('abril');
  await expect(picker.locator('option').first()).toHaveText('Abril');

  await picker.selectOption(book.book);
  await expect(page).toHaveURL(new RegExp(`[?&]book=${book.book}(&|#|$)`));
  return id;
}

async function staysOnBook(page: Page, book: Book, id: string): Promise<void> {
  const picker = page.getByRole('combobox', { name: 'Libro' });
  const card = page.locator(`#sec-cambios article[id$="proposal-${book.book}-${id}"]`);
  await card.getByRole('button', { name: 'Rechazar' }).click();
  await expect(card.locator('.state-badge')).toHaveText('Rechazada');
  await expect(picker).toHaveValue(book.book);

  // A reload keeps it, through the address.
  await page.reload();
  await expect(picker).toHaveValue(book.book);
  await expect(page.locator(`#sec-historial article[id$="proposal-${book.book}-${id}"]`)).toHaveCount(1);

  // A new visit without the address (as when the assistant sends back to /review) keeps it too.
  await page.goto(`${book.base}/review?asistente=1`);
  await expect(picker).toHaveValue(book.book);
  await expect(page).toHaveURL(new RegExp(`[?&]book=${book.book}(&|#|$)`));
  await expect(page.getByText('El libro que tenías abierto')).toHaveCount(0);
}

test('the chosen book stays chosen after an action and a reload', async ({ page, book }) => {
  const id = await chooseSecondBook(page, book);
  await staysOnBook(page, book, id);
});

test.describe('on a phone', () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

  test('the chosen book stays chosen after an action and a reload', async ({ page, book }) => {
    const id = await chooseSecondBook(page, book);
    await staysOnBook(page, book, id);
  });
});
