import type { Page } from '@playwright/test';
import { expect, test } from '../fixtures.ts';

// Esquema view inside Libro (spec S8): planning view with synopsis and status,
// inline edit, filters and jump to desk. Run by CI.

const modeButton = (page: Page, name: string) => page.getByRole('group', { name: 'Modo' }).getByRole('button', { name, exact: true });
const place = (page: Page) => page.getByRole('region', { name: 'Manuscrito del libro' });
const outline = (page: Page) => place(page).locator('.book-outline');

for (const [name, size] of [['desktop', { width: 1280, height: 800 }], ['phone', { width: 390, height: 844 }]] as const) {
  test(`${name}: Esquema view toggles, edits synopsis and status, filters, and jumps to desk`, async ({ page, book }) => {
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.setViewportSize(size);
    await page.goto(`${book.base}/review`);

    await modeButton(page, 'Libro').click();
    await expect(place(page)).toBeVisible();

    // Reading view has status badges next to headings
    await expect(place(page).locator('.book-scene-status').first()).toHaveText('Borrador');

    // Toggle to Esquema
    const viewGroup = place(page).getByRole('group', { name: 'Vista del libro' });
    const leerBtn = viewGroup.getByRole('button', { name: 'Leer' });
    const esquemaBtn = viewGroup.getByRole('button', { name: 'Esquema' });
    await expect(leerBtn).toHaveAttribute('aria-pressed', 'true');
    await expect(esquemaBtn).toHaveAttribute('aria-pressed', 'false');

    await esquemaBtn.click();
    await expect(leerBtn).toHaveAttribute('aria-pressed', 'false');
    await expect(esquemaBtn).toHaveAttribute('aria-pressed', 'true');
    await expect(outline(page)).toBeVisible();

    // Check rows and totals
    const rows = outline(page).locator('.outline-row');
    await expect(rows).toHaveCount(2);
    await expect(outline(page).locator('.outline-total')).toContainText(/Total del libro:/);
    await expect(rows.nth(0).locator('.outline-title')).toHaveText('La puerta de Sal');
    await expect(rows.nth(1).locator('.outline-title')).toHaveText('El altar');

    // Inline synopsis edit on Enter
    const firstSynopsis = rows.nth(0).getByRole('textbox', { name: /^Sinopsis:/ });
    await firstSynopsis.fill('Elena vigila el puente.');
    await firstSynopsis.press('Enter');

    // Verify manifest was committed
    await expect.poll(() => {
      try {
        const manifest = JSON.parse(book.bytes('.rewrite/book.json').toString('utf8'));
        return manifest.synopses?.['scenes/escena-01.md'];
      } catch {
        return null;
      }
    }).toBe('Elena vigila el puente.');

    // Escape cancels edit
    await firstSynopsis.fill('Texto no guardado');
    await firstSynopsis.press('Escape');
    await expect(firstSynopsis).toHaveValue('Elena vigila el puente.');

    // Status selector change
    const firstStatus = rows.nth(0).getByRole('combobox', { name: /^Estado:/ });
    await firstStatus.selectOption('final');

    await expect.poll(() => {
      try {
        const manifest = JSON.parse(book.bytes('.rewrite/book.json').toString('utf8'));
        return manifest.statuses?.['scenes/escena-01.md'];
      } catch {
        return null;
      }
    }).toBe('final');

    // Filter by status
    const filterGroup = outline(page).getByRole('group', { name: 'Filtrar por estado' });
    await filterGroup.getByRole('button', { name: 'Terminado' }).click();
    await expect(rows.nth(0)).toBeVisible();
    await expect(rows.nth(1)).toBeHidden();

    await filterGroup.getByRole('button', { name: 'Borrador' }).click();
    await expect(rows.nth(0)).toBeHidden();
    await expect(rows.nth(1)).toBeVisible();

    await filterGroup.getByRole('button', { name: 'Todas' }).click();
    await expect(rows.nth(0)).toBeVisible();
    await expect(rows.nth(1)).toBeVisible();

    await page.screenshot({ path: test.info().outputPath(`esquema-${name}.png`) });

    // Escribir aquí jumps to the desk
    await rows.nth(1).getByRole('button', { name: /^Escribir aquí:/ }).click();
    await expect(place(page)).toBeHidden();
    await expect(modeButton(page, 'Concentración')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('.desk-title')).toHaveText('El altar');

    expect(errors).toEqual([]);
  });
}
