import { devices, type Page } from '@playwright/test';
import { ANNOTATIONS, expect, test, type Book } from '../fixtures.ts';

// The modes of issue #101 (docs/design.md, "Modes"): Concentración and Ayuda RE;write around
// one scene editor, and Revisión, the full review page. Each test switches modes with unsaved
// text and the caret inside a paragraph, and checks that both survive. Screenshots of both
// writing modes, light and dark, on desktop and on a phone go to test-results/.

const SCENE = 'scenes/escena-01.md';
const QUOTE = 'Elena llevaba once años custodiando el puente de Sal';

const modeButton = (page: Page, name: string) => page.getByRole('group', { name: 'Modo' }).getByRole('button', { name, exact: true });
const content = (page: Page) => page.getByRole('textbox', { name: /^Texto de la escena / });
const paragraph = (page: Page) => page.locator('.desk .cm-content .cm-line').nth(2);

function setup(book: Book): void {
  book.cli('extract', '--from', ANNOTATIONS);
  book.cli('propose', '--file', SCENE, '--find', 'once años', '--replace', 'doce años', '--rationale', 'Edad de Elena');
  book.cli('propose', '--file', 'scenes/escena-02.md', '--find', 'una vela casi consumida', '--replace', 'una vela nueva', '--rationale', 'Otra escena');
}

// Fails the test on any CSP report or script error the page logs.
function watchConsole(page: Page): string[] {
  const errors: string[] = [];
  page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
  page.on('pageerror', (error) => errors.push(error.message));
  return errors;
}

async function shoot(page: Page, name: string): Promise<void> {
  for (const scheme of ['light', 'dark'] as const) {
    // Reduced motion: no colour transition is caught halfway in the picture.
    await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' });
    await page.screenshot({ path: test.info().outputPath(`${name}-${scheme}.png`) });
  }
  await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'no-preference' });
}

/** Puts the caret after "Elena " in the first paragraph and types there, unsaved. */
async function typeInParagraph(page: Page, tap: boolean): Promise<void> {
  await expect(paragraph(page)).toHaveText(/^Elena llevaba/);
  if (tap) await paragraph(page).tap(); else await paragraph(page).click();
  await page.keyboard.press('Home');
  for (let i = 0; i < 'Elena'.length; i++) await page.keyboard.press('ArrowRight');
  await page.keyboard.type(' (sin guardar)');
  await expect(paragraph(page)).toHaveText(/^Elena \(sin guardar\) llevaba/);
  await expect(page.locator('.desk .save-status')).toHaveText('Cambios sin guardar');
}

async function switchAround(page: Page, book: Book, original: string, tap: boolean): Promise<void> {
  const press = async (name: string) => { if (tap) await modeButton(page, name).tap(); else await modeButton(page, name).click(); };
  await press('Ayuda RE;write');
  await expect(page.locator('.desk-help')).toContainText('Edad de Elena');
  await press('Revisión');
  await expect(page.locator('.desk')).toBeHidden();
  await expect(page.getByRole('navigation', { name: 'Secciones' }).getByRole('link')).toHaveCount(8);
  for (const heading of ['Cambios propuestos', 'Hallazgos de la trama', 'Posibles problemas', 'Afirmaciones por revisar', 'Canon', 'Historial de cambios del manuscrito']) {
    await expect(page.getByRole('button', { name: heading, exact: true })).toBeAttached();
  }
  await press('Concentración');
  // The caret comes back where it was: the next key lands inside the same paragraph.
  await page.keyboard.type('!');
  await expect(paragraph(page)).toHaveText(/^Elena \(sin guardar\)! llevaba/);
  expect(book.bytes(SCENE).toString('utf8')).toBe(original);
}

test('desktop: the modes keep the unsaved text and the caret, Concentración hides the review and Ayuda shows this scene', async ({ page, book }) => {
  const errors = watchConsole(page);
  setup(book);
  const original = book.bytes(SCENE).toString('utf8');
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`${book.base}/review`);
  await expect(modeButton(page, 'Revisión')).toHaveAttribute('aria-pressed', 'true');
  await modeButton(page, 'Concentración').click();
  await expect(page.locator('.desk .cm-editor')).toBeVisible();
  await expect(page.getByRole('navigation', { name: 'Secciones' })).toBeHidden();
  await expect(page.locator('#sec-cambios')).toBeHidden();
  await expect(page.locator('.desk-help')).toBeEmpty();
  await expect(page.locator('.desk-title')).toHaveText('La puerta de Sal');
  await expect(page.locator('.desk-count')).toHaveText(/^\d+ palabras$/);
  await typeInParagraph(page, false);
  await shoot(page, 'desktop-concentracion');

  await switchAround(page, book, original, false);

  await modeButton(page, 'Ayuda RE;write').click();
  const help = page.getByRole('complementary', { name: 'Ayuda para esta escena' });
  await expect(help).toBeVisible();
  await expect(help).toContainText('Edad de Elena');
  await expect(help).not.toContainText('Otra escena');
  // Desktop uses the width: the help column sits to the right of the editor.
  const editorBox = (await page.locator('.desk-editor').boundingBox())!;
  const helpBox = (await help.boundingBox())!;
  expect(helpBox.x).toBeGreaterThanOrEqual(editorBox.x + editorBox.width);
  await shoot(page, 'desktop-ayuda');

  // A claim's quote selects its words in the editor.
  await help.locator('blockquote', { hasText: 'Dicen que Bruno vendió la llave del puente a los de Ribera' }).click();
  await expect.poll(() => page.evaluate(() => String(window.getSelection()))).toBe('Dicen que Bruno vendió la llave del puente a los de Ribera');

  await page.keyboard.press('Control+s');
  await expect(page.locator('.desk .save-status')).toHaveText('Guardado');
  expect(book.bytes(SCENE).toString('utf8')).toBe(original.replace('Elena llevaba', 'Elena (sin guardar)! llevaba'));
  expect(errors).toEqual([]);
});

test('a quote the person already rewrote says so instead of selecting something else', async ({ page, book }) => {
  setup(book);
  await page.goto(`${book.base}/review`);
  await modeButton(page, 'Ayuda RE;write').click();
  await content(page).click();
  await page.keyboard.press('Control+Home');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Shift+End');
  await page.keyboard.type('Otro comienzo.');
  await page.getByRole('complementary', { name: 'Ayuda para esta escena' }).locator('blockquote', { hasText: QUOTE }).click();
  await expect(page.getByText('No se encuentra la cita en el texto del editor')).toBeVisible();
});

test.describe('with the assistant', () => {
  test.use({ engine: true });

  test('Concentración closes the assistant and keeps it one tap away; Ayuda offers it for the scene', async ({ page, book }) => {
    const errors = watchConsole(page);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`${book.base}/review`);
    await page.getByRole('button', { name: 'Asistente', exact: true }).first().click();
    await expect(page.getByRole('complementary', { name: 'Asistente' })).toBeVisible();
    await modeButton(page, 'Concentración').click();
    await expect(page.getByRole('complementary', { name: 'Asistente' })).toBeHidden();
    await expect(page.locator('.assistant-fab')).toBeVisible();
    await page.reload();
    await expect(page.locator('.desk .cm-editor')).toBeVisible();
    await expect(page.getByRole('complementary', { name: 'Asistente' })).toBeHidden();

    await modeButton(page, 'Ayuda RE;write').click();
    await page.getByRole('button', { name: 'Preguntar al asistente por esta escena' }).click();
    await expect(page.getByRole('complementary', { name: 'Asistente' })).toBeVisible();
    await expect(page.locator('.assistant-context')).toContainText('escena-01');
    expect(errors).toEqual([]);
  });
});

const { defaultBrowserType: _phoneBrowser, ...phone } = devices['Pixel 7'];
test.describe('on a phone', () => {
  test.use(phone);

  test('the switch is a dock under the thumb, and Ayuda is one tap from the text', async ({ page, book }) => {
    const errors = watchConsole(page);
    setup(book);
    const original = book.bytes(SCENE).toString('utf8');
    await page.goto(`${book.base}/review`);
    const dock = page.getByRole('group', { name: 'Modo' });
    const viewport = page.viewportSize()!;
    const box = (await dock.boundingBox())!;
    expect(Math.round(box.y + box.height)).toBe(viewport.height);
    for (const name of ['Concentración', 'Ayuda RE;write', 'Revisión']) {
      expect((await modeButton(page, name).boundingBox())!.height).toBeGreaterThanOrEqual(44);
    }
    await modeButton(page, 'Concentración').tap();
    await expect(page.locator('.desk .cm-editor')).toBeVisible();
    const select = page.getByRole('combobox', { name: 'Escena' });
    expect(await select.evaluate((node) => parseFloat(getComputedStyle(node).fontSize))).toBeGreaterThanOrEqual(16);
    await typeInParagraph(page, true);
    await shoot(page, 'phone-concentracion');

    await switchAround(page, book, original, true);

    await modeButton(page, 'Ayuda RE;write').tap();
    const panes = page.getByRole('group', { name: 'Panel' });
    await panes.getByRole('button', { name: /^Ayuda \(\d+\)$/ }).tap();
    const help = page.getByRole('complementary', { name: 'Ayuda para esta escena' });
    await expect(help).toBeVisible();
    await expect(page.locator('.desk-editor')).toBeHidden();
    await shoot(page, 'phone-ayuda');
    await help.locator('blockquote', { hasText: 'Dicen que Bruno vendió la llave del puente a los de Ribera' }).tap();
    await expect(page.locator('.desk-editor')).toBeVisible();
    await expect.poll(() => page.evaluate(() => String(window.getSelection()))).toBe('Dicen que Bruno vendió la llave del puente a los de Ribera');
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow).toBeLessThanOrEqual(0);
    expect(errors).toEqual([]);
  });
});
