import type { Page } from '@playwright/test';
import { expect, test } from '../fixtures.ts';

// Libro (docs/design.md, "Modes"): the whole manuscript to read, its contents with counts, and
// "Escribir aquí" back into the desk at that scene. Run by CI.

const modeButton = (page: Page, name: string) => page.getByRole('group', { name: 'Modo' }).getByRole('button', { name, exact: true });
const place = (page: Page) => page.getByRole('region', { name: 'Manuscrito del libro' });

for (const [name, size] of [['desktop', { width: 1280, height: 800 }], ['phone', { width: 390, height: 844 }]] as const) {
  test(`${name}: Libro reads the whole book, jumps from the contents, and Escribir aquí opens the desk at that scene`, async ({ page, book }) => {
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.setViewportSize(size);
    await page.goto(`${book.base}/review`);
    await modeButton(page, 'Concentración').click();
    await expect(page.locator('.desk .cm-editor')).toBeVisible();
    await modeButton(page, 'Libro').click();

    await expect(place(page).locator('.book-scene')).toHaveCount(2);
    await expect(place(page).getByText('Elena llevaba once años custodiando el puente de Sal')).toBeVisible();
    await expect(place(page).locator('.book-toc-total')).toContainText('Total del libro:');

    const contents = place(page).getByRole('navigation', { name: 'Contenido del libro' });
    if (name === 'phone') {
      await expect(contents).toBeHidden();
      await place(page).getByRole('button', { name: 'Contenido' }).click();
    }
    await contents.getByRole('button', { name: /El altar/ }).click();
    await expect(place(page).locator('#libro-escena-2 h3')).toBeFocused();
    await page.screenshot({ path: test.info().outputPath(`libro-${name}.png`) });

    await place(page).getByRole('button', { name: /^Escribir aquí: El altar/ }).click();
    await expect(place(page)).toBeHidden();
    await expect(modeButton(page, 'Concentración')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('.desk-title')).toHaveText('El altar');
    expect(errors).toEqual([]);
  });
}
