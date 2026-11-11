import type { Page } from '@playwright/test';
import { expect, test, type Book } from '../fixtures.ts';

// The formatting toolbar of the writing desk and its phone layout (issue #101, docs/design.md,
// "Scene editor" and "Modes"). Every action is checked against the bytes saved on disk; the
// phone keyboard is simulated by shrinking the viewport, which shrinks the visual viewport.

const SCENE = 'scenes/escena-01.md';
const DESKTOP = { width: 1280, height: 800 };

const modeButton = (page: Page, name: string) => page.getByRole('group', { name: 'Modo' }).getByRole('button', { name, exact: true });
const format = (page: Page, name: string) => page.locator('.desk').getByRole('group', { name: 'Formato' }).getByRole('button', { name, exact: true });
const line = (page: Page, n: number) => page.locator('.desk .cm-content .cm-line').nth(n);

function watchConsole(page: Page): string[] {
  const errors: string[] = [];
  page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
  page.on('pageerror', (error) => errors.push(error.message));
  return errors;
}

async function openDesk(page: Page, book: Book, mode = 'Concentración'): Promise<void> {
  await page.goto(`${book.base}/review`);
  await modeButton(page, mode).click();
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

/** Puts the caret at the start of line n (0-based) of the editor, by its first visual row. */
async function caretAtLine(page: Page, n: number): Promise<void> {
  await line(page, n).click({ position: { x: 4, y: 4 } });
  await page.keyboard.press('Home');
}

const noSideScroll = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);

test('desktop: each toolbar action and Ctrl+B/I edit the Markdown like typing, undo one step each, and save the exact bytes', async ({ page, book }) => {
  const errors = watchConsole(page);
  await page.setViewportSize(DESKTOP);
  const original = book.bytes(SCENE).toString('utf8');
  await openDesk(page, book);
  const toolbar = page.locator('.desk').getByRole('group', { name: 'Formato' });
  await expect(toolbar).toBeVisible();
  // Desktop: all the buttons show; the Formato fold is a phone thing.
  await expect(toolbar.getByRole('button', { name: 'Formato' })).toBeHidden();
  for (const name of ['Negrita', 'Cursiva', 'Título 1', 'Título 2', 'Título 3', 'Cita', 'Lista', 'Lista numerada', 'Separador de escena', 'Enlace a nota']) {
    const btn = format(page, name);
    await expect(btn).toBeVisible();
    expect((await btn.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  }

  // Negrita on a selected word, from the toolbar: the text keeps the focus and the selection.
  await caretAtLine(page, 2);
  for (let i = 0; i < 'Elena '.length; i++) await page.keyboard.press('ArrowRight');
  for (let i = 0; i < 'llevaba'.length; i++) await page.keyboard.press('Shift+ArrowRight');
  await format(page, 'Negrita').click();
  await expect(line(page, 2)).toHaveText(/^Elena \*\*llevaba\*\* once/);
  await expect(format(page, 'Negrita')).toHaveAttribute('aria-pressed', 'true');
  // Ctrl+I adds italic around it, a second Ctrl+I takes only the italic away.
  await page.keyboard.press('Control+i');
  await expect(line(page, 2)).toHaveText(/^Elena \*\*\*llevaba\*\*\* once/);
  await page.keyboard.press('Control+i');
  await expect(line(page, 2)).toHaveText(/^Elena \*\*llevaba\*\* once/);
  // Ctrl+B twice: off and on again. Each press is one undo step.
  await page.keyboard.press('Control+b');
  await expect(line(page, 2)).toHaveText(/^Elena llevaba once/);
  await page.keyboard.press('Control+z');
  await expect(line(page, 2)).toHaveText(/^Elena \*\*llevaba\*\* once/);

  await caretAtLine(page, 0);
  await format(page, 'Título 2').click();
  await expect(line(page, 0)).toHaveText('## La puerta de Sal');
  await caretAtLine(page, 4);
  await format(page, 'Cita').click();
  await caretAtLine(page, 8);
  await format(page, 'Lista numerada').click();
  await caretAtLine(page, 6);
  await format(page, 'Lista').click();
  await format(page, 'Lista').click();

  // A scene break and a note link at the end of the text.
  await page.keyboard.press('Control+End');
  await format(page, 'Separador de escena').click();
  await page.keyboard.type('Habló con ');
  await format(page, 'Enlace a nota').click();
  await page.keyboard.press('Escape');
  await page.keyboard.type('Elena]]');

  await page.keyboard.press('Control+s');
  await expect(page.locator('.desk .save-status')).toHaveText('Guardado');
  const expected = original
    .replace('# La puerta de Sal\n', '## La puerta de Sal\n')
    .replace('Elena llevaba once', 'Elena **llevaba** once')
    .replace('El guardia escupió', '> El guardia escupió')
    .replace('Elena cerró el libro', '1. Elena cerró el libro')
    + '\n***\n\nHabló con [[Elena]]';
  expect(book.bytes(SCENE).toString('utf8')).toBe(expected);
  await shoot(page, 'toolbar-desktop');
  expect(errors).toEqual([]);
});

for (const size of [{ width: 360, height: 740 }, { width: 390, height: 844 }]) {
  test(`phone ${size.width}x${size.height}: the toolbar folds, nothing overflows, and with the keyboard open the caret and the save state stay visible`, async ({ page, book }) => {
    const errors = watchConsole(page);
    await page.setViewportSize(size);
    await openDesk(page, book);
    const toolbar = page.locator('.desk').getByRole('group', { name: 'Formato' });
    const fold = toolbar.getByRole('button', { name: 'Formato' });
    await expect(fold).toBeVisible();
    await expect(format(page, 'Negrita')).toBeHidden();
    expect(await noSideScroll(page)).toBe(true);
    await shoot(page, `phone-${size.width}-folded`);

    // Open, its buttons scroll sideways inside one row: the page itself never does.
    await caretAtLine(page, 2);
    await fold.click();
    await expect(fold).toHaveAttribute('aria-expanded', 'true');
    await expect(format(page, 'Negrita')).toBeVisible();
    expect((await format(page, 'Negrita').boundingBox())!.height).toBeGreaterThanOrEqual(44);
    expect(await noSideScroll(page)).toBe(true);
    await format(page, 'Cursiva').click();
    // At the cursor, Cursiva takes the word it stands on.
    await expect(line(page, 2)).toHaveText(/^\*Elena\* llevaba/);
    await shoot(page, `phone-${size.width}-toolbar`);

    // The dock sits below the text, never over the toolbar or the scene list.
    const dock = (await page.locator('.mode-switch').boundingBox())!;
    const head = (await page.locator('.desk .scene-head').boundingBox())!;
    expect(head.y + head.height).toBeLessThanOrEqual(dock.y);
    expect(dock.y + dock.height).toBeCloseTo(size.height, 0);

    // The keyboard: the caret at the end of the text, then the visible height drops by 45%.
    await page.keyboard.press('Control+End');
    await page.keyboard.type('Sigue');
    await page.setViewportSize({ width: size.width, height: Math.round(size.height * 0.55) });
    await expect(page.locator('body')).toHaveClass(/keyboard-open/);
    await expect(page.locator('.mode-switch')).toBeHidden();
    const seen = async () => page.evaluate(() => {
      const sel = window.getSelection()!;
      const node = sel.focusNode!;
      const caretLine = (node.nodeType === 1 ? (node as Element) : node.parentElement!).closest('.cm-line')!.getBoundingClientRect();
      const head = document.querySelector('.desk .scene-head')!.getBoundingClientRect();
      const status = document.querySelector('.desk .save-status')!.getBoundingClientRect();
      const vv = window.visualViewport!;
      return { caretTop: caretLine.top, caretBottom: caretLine.bottom, headBottom: head.bottom, statusTop: status.top, statusBottom: status.bottom, top: vv.offsetTop, bottom: vv.offsetTop + vv.height };
    });
    const typing = await seen();
    expect(typing.caretTop, 'the caret is below the sticky head').toBeGreaterThanOrEqual(typing.headBottom - 1);
    expect(typing.caretBottom, 'and above the keyboard').toBeLessThanOrEqual(typing.bottom + 1);
    expect(typing.statusTop, 'the save state is on screen').toBeGreaterThanOrEqual(typing.top - 1);
    expect(typing.statusBottom).toBeLessThanOrEqual(typing.bottom + 1);
    await expect(page.locator('.desk .save-status')).toHaveText('Cambios sin guardar');
    await page.keyboard.type(' más');
    const after = await seen();
    expect(after.caretBottom).toBeLessThanOrEqual(after.bottom + 1);
    expect(await noSideScroll(page)).toBe(true);
    await shoot(page, `phone-${size.width}-keyboard`);

    // The keyboard goes away: the dock comes back.
    await page.setViewportSize(size);
    await expect(page.locator('body')).not.toHaveClass(/keyboard-open/);
    await expect(page.locator('.mode-switch')).toBeVisible();

    // Ayuda with Analizar open, and the notes list: still no sideways scroll.
    await modeButton(page, 'Ayuda RE;write').click();
    await page.locator('.desk').getByRole('button', { name: 'Analizar', exact: true }).click();
    await expect(page.locator('.desk-analyse')).toBeVisible();
    expect(await noSideScroll(page)).toBe(true);
    await shoot(page, `phone-${size.width}-analizar`);
    await page.locator('.desk').getByRole('button', { name: 'Notas', exact: true }).click();
    expect(await noSideScroll(page)).toBe(true);
    expect(errors).toEqual([]);
  });
}
