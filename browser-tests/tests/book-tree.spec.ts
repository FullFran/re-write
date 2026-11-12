import type { Page } from '@playwright/test';
import { expect, test } from '../fixtures.ts';

// The book tree drawer (docs/book-structure.md): chapters, scenes, word counts, the total and the
// open scene; structure edits are person-only commits; reorder by drag and by keyboard; on a phone
// the tree is a drawer over the text. Run by CI only.

const SCENE = 'scenes/escena-01.md';
const OTHER = 'scenes/escena-02.md';

const modeButton = (page: Page, name: string) => page.getByRole('group', { name: 'Modo' }).getByRole('button', { name, exact: true });
const drawer = (page: Page) => page.getByRole('navigation', { name: 'Índice' });
// The manifest's loose list, or null before the first structural write creates the file.
const loose = (book: { bytes: (file: string) => Buffer }) => {
  try { return JSON.parse(book.bytes('.rewrite/book.json').toString('utf8')).loose; } catch { return null; }
};
// A row's actions show for the open scene or when the row has the focus, never on hover.
const row = (page: Page, name: string) => drawer(page).locator('.tree-scene', { has: page.locator('.tree-name', { hasText: name }) });
const toggle = (page: Page) => page.getByRole('group', { name: 'Notas y grafo del libro' }).getByRole('button', { name: 'Índice', exact: true });

async function openTree(page: Page, base: string): Promise<void> {
  await page.goto(`${base}/review`);
  await modeButton(page, 'Concentración').click();
  await expect(page.locator('.desk .cm-editor')).toBeVisible();
  await toggle(page).click();
  await expect(drawer(page)).toBeVisible();
}

test('the drawer shows the book total and the open scene, and creating a chapter and a scene is one commit each', async ({ page, book }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openTree(page, book.base);
  await expect(drawer(page)).toContainText(/Libro: [\d.]+ palabras/);
  await expect(drawer(page).locator('[aria-current=true]')).toHaveText('La puerta de Sal');

  const before = Number(book.git('rev-list', '--count', 'HEAD'));
  await drawer(page).getByRole('button', { name: 'Nuevo capítulo' }).click();
  await page.getByRole('textbox', { name: 'Título del nuevo capítulo' }).fill('Primera parte');
  await page.keyboard.press('Enter');
  await expect(drawer(page).getByRole('heading', { name: 'Primera parte' })).toBeVisible();
  await drawer(page).getByRole('button', { name: 'Nueva escena' }).click();
  await page.getByRole('textbox', { name: 'Título de la nueva escena' }).fill('Llegada');
  await page.getByRole('combobox', { name: 'Capítulo' }).selectOption({ label: 'Primera parte' });
  await drawer(page).getByRole('button', { name: 'Crear escena' }).click();
  await expect(page.locator('.desk-title')).toHaveText('Llegada');
  expect(Number(book.git('rev-list', '--count', 'HEAD'))).toBe(before + 2);
  expect(book.bytes('scenes/llegada.md').toString('utf8')).toBe('# Llegada\n');
});

test('scenes reorder from the keyboard, the focus stays on the control, and a drag does the same', async ({ page, book }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openTree(page, book.base);
  const down = drawer(page).getByRole('button', { name: 'Bajar «La puerta de Sal»' });
  await down.focus();
  await page.keyboard.press('Enter');
  await expect.poll(() => loose(book)).toEqual([OTHER, SCENE]);
  await expect(drawer(page).getByRole('button', { name: 'Bajar «La puerta de Sal»' })).toBeFocused();

  const names = drawer(page).locator('.tree-name');
  await expect(names).toHaveText(['El altar', 'La puerta de Sal']);
  await names.nth(1).dragTo(names.nth(0));
  await expect(names).toHaveText(['La puerta de Sal', 'El altar']);
  await expect.poll(() => loose(book)).toEqual([SCENE, OTHER]);
});

test('switching scenes from the tree keeps unsaved text; on a phone the tree is a drawer over the text that closes on choosing', async ({ page, book }) => {
  await page.setViewportSize({ width: 390, height: 800 });
  await openTree(page, book.base);
  const box = (await drawer(page).boundingBox())!;
  expect(box.x).toBe(0);
  expect(box.width).toBeLessThanOrEqual(390);
  await drawer(page).getByRole('button', { name: 'Cerrar el índice' }).click();
  await expect(drawer(page)).toBeHidden();

  const text = page.getByRole('textbox', { name: /^Texto de la escena / });
  await text.click();
  await page.keyboard.press('Control+End');
  await page.keyboard.type('Sin guardar.');
  await toggle(page).click();
  await drawer(page).locator('.tree-name', { hasText: 'El altar' }).click();
  await expect(drawer(page)).toBeHidden();
  await expect(page.locator('.desk-title')).toHaveText('El altar');
  await toggle(page).click();
  await drawer(page).locator('.tree-name', { hasText: 'La puerta de Sal' }).click();
  await expect(text).toContainText('Sin guardar.');
  expect(book.bytes(SCENE).toString('utf8')).not.toContain('Sin guardar.');
});

test('archiving a scene moves it to Archivo and restoring brings it back, with no file deleted', async ({ page, book }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openTree(page, book.base);
  await row(page, 'El altar').locator('.tree-name').focus();
  await drawer(page).getByRole('button', { name: 'Archivar «El altar»' }).click();
  await expect(drawer(page).getByRole('button', { name: 'Archivo (1)' })).toBeVisible();
  expect(book.bytes(OTHER).length).toBeGreaterThan(0);
  await drawer(page).getByRole('button', { name: 'Archivo (1)' }).click();
  await drawer(page).getByRole('button', { name: 'Restaurar «El altar»' }).click();
  await expect(drawer(page).getByRole('button', { name: 'Archivo (0)' })).toBeVisible();
  await expect(drawer(page).locator('.tree-name')).toHaveText(['La puerta de Sal', 'El altar']);
});
