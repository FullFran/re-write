import type { Page } from '@playwright/test';
import { expect, test, type Book } from '../fixtures.ts';

// Search and replace inside the scene editor (issue #101, docs/design.md, "Scene editor").
// Every replacement is checked against the bytes saved on disk: it edits the raw Markdown as
// typing would. The phone keyboard is simulated by shrinking the viewport, as in
// format-toolbar.spec.ts.

const SCENE = 'scenes/escena-01.md';
const DESKTOP = { width: 1280, height: 800 };

const modeButton = (page: Page, name: string) => page.getByRole('group', { name: 'Modo' }).getByRole('button', { name, exact: true });
const line = (page: Page, n: number) => page.locator('.desk .cm-content .cm-line').nth(n);
const panel = (page: Page) => page.locator('.desk .cm-search');
const control = (page: Page, name: string) => panel(page).getByRole('button', { name, exact: true });
const field = (page: Page, name: string) => panel(page).getByRole('textbox', { name, exact: true });
const option = (page: Page, name: string) => panel(page).getByLabel(name, { exact: true });

function watchConsole(page: Page): string[] {
  const errors: string[] = [];
  page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
  page.on('pageerror', (error) => errors.push(error.message));
  return errors;
}

async function openDesk(page: Page, book: Book): Promise<void> {
  await page.goto(`${book.base}/review`);
  await modeButton(page, 'Concentración').click();
  await expect(page.locator('.desk .cm-editor')).toBeVisible();
  await expect(line(page, 2)).toHaveText(/^Elena llevaba/);
}

async function shoot(page: Page, name: string): Promise<void> {
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' });
    await page.screenshot({ path: test.info().outputPath(`${name}-${scheme}.png`) });
  }
  await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'no-preference' });
}

/** Every control of the panel is at least 44 px high. */
async function expectTapTargets(page: Page): Promise<void> {
  const boxes = [
    field(page, 'Buscar'), field(page, 'Reemplazar'),
    control(page, 'Siguiente'), control(page, 'Anterior'), control(page, 'Reemplazar'), control(page, 'Reemplazar todo'), control(page, 'Cerrar búsqueda'),
    panel(page).locator('label').filter({ hasText: 'Distinguir mayúsculas' }),
    panel(page).locator('label').filter({ hasText: 'Palabra completa' }),
    panel(page).locator('label').filter({ hasText: 'Expresión regular' }),
  ];
  for (const box of boxes) {
    await expect(box).toBeVisible();
    expect((await box.boundingBox())!.height, String(box)).toBeGreaterThanOrEqual(44);
  }
}

const noSideScroll = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);

test('desktop: Ctrl+F searches; Reemplazar, Reemplazar todo, case, whole word and regex edit the Markdown like typing and save the exact bytes', async ({ page, book }) => {
  const errors = watchConsole(page);
  await page.setViewportSize(DESKTOP);
  const original = book.bytes(SCENE).toString('utf8');
  await openDesk(page, book);
  const buscar = page.locator('.desk').getByRole('group', { name: 'Formato' }).getByRole('button', { name: 'Buscar', exact: true });
  await expect(buscar).toBeVisible();
  await expect(buscar).toHaveAttribute('aria-expanded', 'false');

  // Ctrl+F from the text opens the panel, in Spanish, with the words to find focused.
  await line(page, 0).click();
  await page.keyboard.press('Control+Home');
  await page.keyboard.press('Control+f');
  await expect(panel(page)).toBeVisible();
  await expect(field(page, 'Buscar')).toBeFocused();
  await expect(buscar).toHaveAttribute('aria-expanded', 'true');
  await expectTapTargets(page);
  // The panel is in the sticky head, under the toolbar, never over the text.
  const head = (await page.locator('.desk .scene-head').boundingBox())!;
  const found = (await panel(page).boundingBox())!;
  expect(found.y + found.height).toBeLessThanOrEqual(head.y + head.height + 1);

  // Search: every match is marked; Enter goes to the first one after the cursor.
  await page.keyboard.type('puente');
  await expect(page.locator('.desk .cm-searchMatch')).toHaveCount(3);
  await field(page, 'Buscar').press('Enter');
  await expect(page.locator('.desk .cm-searchMatch-selected')).toHaveText('puente');
  await shoot(page, 'search-desktop');

  // Reemplazar changes the selected match only.
  await field(page, 'Reemplazar').fill('pasarela');
  await control(page, 'Reemplazar').click();
  await expect(line(page, 2)).toContainText('custodiando el pasarela de Sal');
  await expect(page.locator('.desk .cm-searchMatch')).toHaveCount(2);
  await expect(page.locator('.desk .save-status')).toHaveText('Cambios sin guardar');
  // Reemplazar todo changes the rest, in one step.
  await control(page, 'Reemplazar todo').click();
  await expect(page.locator('.desk .cm-searchMatch')).toHaveCount(0);
  await expect(line(page, 6)).toContainText('la llave del pasarela a los de Ribera');

  // Distinguir mayúsculas and Palabra completa: "El" is neither "el" nor the start of "Elena".
  await option(page, 'Distinguir mayúsculas').check();
  await option(page, 'Palabra completa').check();
  await field(page, 'Buscar').fill('El');
  await expect(page.locator('.desk .cm-searchMatch')).toHaveCount(2);
  await field(page, 'Reemplazar').fill('Aquel');
  await control(page, 'Reemplazar todo').click();
  await expect(line(page, 4)).toHaveText(/^Aquel guardia escupió/);
  await expect(line(page, 2)).toHaveText(/^Elena llevaba/);

  // Expresión regular, with a group in the replacement.
  await option(page, 'Palabra completa').uncheck();
  await option(page, 'Expresión regular').check();
  await field(page, 'Buscar').fill('(que|fue) Bruno');
  await expect(page.locator('.desk .cm-searchMatch')).toHaveCount(2);
  await field(page, 'Reemplazar').fill('$1 Bruno Sal');
  await control(page, 'Reemplazar todo').click();
  await expect(line(page, 6)).toHaveText(/^—Dicen que Bruno Sal vendió/);
  await expect(line(page, 10)).toHaveText(/^—No fue Bruno Sal —dijo/);

  // Escape closes the panel and gives the text the focus; Ctrl+Z takes the whole Reemplazar
  // todo back in one step, Ctrl+Y puts it back.
  await field(page, 'Buscar').press('Escape');
  await expect(panel(page)).toHaveCount(0);
  await expect(buscar).toHaveAttribute('aria-expanded', 'false');
  await expect(page.locator('.desk .cm-content')).toBeFocused();
  await page.keyboard.press('Control+z');
  await expect(line(page, 6)).toHaveText(/^—Dicen que Bruno vendió/);
  await expect(line(page, 10)).toHaveText(/^—No fue Bruno —dijo/);
  await page.keyboard.press('Control+y');
  await expect(line(page, 10)).toHaveText(/^—No fue Bruno Sal —dijo/);

  await page.keyboard.press('Control+s');
  await expect(page.locator('.desk .save-status')).toHaveText('Guardado');
  const expected = original
    .replaceAll('puente', 'pasarela')
    .replaceAll('El guardia', 'Aquel guardia')
    .replace('que Bruno', 'que Bruno Sal')
    .replace('fue Bruno', 'fue Bruno Sal');
  expect(book.bytes(SCENE).toString('utf8')).toBe(expected);
  expect(errors).toEqual([]);
});

test('Lectura closes the panel; back in the live view Buscar opens it again', async ({ page, book }) => {
  await page.setViewportSize(DESKTOP);
  await openDesk(page, book);
  await page.locator('.desk').getByRole('group', { name: 'Formato' }).getByRole('button', { name: 'Buscar', exact: true }).click();
  await expect(panel(page)).toBeVisible();
  await page.getByRole('group', { name: 'Vista del editor' }).getByRole('button', { name: 'Lectura', exact: true }).click();
  await expect(panel(page)).toHaveCount(0);
  await page.getByRole('group', { name: 'Vista del editor' }).getByRole('button', { name: 'Vista previa en vivo', exact: true }).click();
  await page.locator('.desk').getByRole('group', { name: 'Formato' }).getByRole('button', { name: 'Buscar', exact: true }).click();
  await expect(field(page, 'Buscar')).toBeFocused();
});

for (const size of [{ width: 360, height: 740 }, { width: 390, height: 844 }]) {
  test(`phone ${size.width}x${size.height}: Buscar opens the panel above the keyboard, its controls are 44 px, and Reemplazar todo saves the exact bytes`, async ({ page, book }) => {
    const errors = watchConsole(page);
    await page.setViewportSize(size);
    const original = book.bytes(SCENE).toString('utf8');
    await openDesk(page, book);
    // Phones have no Ctrl+F: Buscar shows next to Formato, without opening the fold.
    const buscar = page.locator('.desk').getByRole('group', { name: 'Formato' }).getByRole('button', { name: 'Buscar', exact: true });
    await expect(buscar).toBeVisible();
    expect((await buscar.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    await line(page, 2).click();
    await buscar.click();
    await expect(field(page, 'Buscar')).toBeFocused();
    await expectTapTargets(page);
    expect(await noSideScroll(page)).toBe(true);
    await shoot(page, `search-phone-${size.width}`);

    // The keyboard opens: the panel stays in the visible part of the screen.
    await page.setViewportSize({ width: size.width, height: Math.round(size.height * 0.55) });
    await expect(page.locator('body')).toHaveClass(/keyboard-open/);
    await page.keyboard.type('Elena');
    await expect(page.locator('.desk .cm-searchMatch').first()).toBeVisible();
    const seen = await page.evaluate(() => {
      const box = document.querySelector('.desk .cm-search')!.getBoundingClientRect();
      const vv = window.visualViewport!;
      return { top: box.top, bottom: box.bottom, vvTop: vv.offsetTop, vvBottom: vv.offsetTop + vv.height };
    });
    expect(seen.top).toBeGreaterThanOrEqual(seen.vvTop - 1);
    expect(seen.bottom).toBeLessThanOrEqual(seen.vvBottom + 1);
    await field(page, 'Reemplazar').fill('Elena Sal');
    await control(page, 'Reemplazar todo').click();
    expect(await noSideScroll(page)).toBe(true);
    await shoot(page, `search-phone-${size.width}-keyboard`);

    // Buscar again closes it.
    await page.setViewportSize(size);
    await buscar.click();
    await expect(panel(page)).toHaveCount(0);
    await page.locator('.desk').getByRole('button', { name: 'Guardar', exact: true }).click();
    await expect(page.locator('.desk .save-status')).toHaveText('Guardado');
    expect(book.bytes(SCENE).toString('utf8')).toBe(original.replaceAll('Elena', 'Elena Sal'));
    expect(errors).toEqual([]);
  });
}
