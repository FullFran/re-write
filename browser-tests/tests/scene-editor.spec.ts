import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { devices, type Page } from '@playwright/test';
import { expect, test, type Book } from '../fixtures.ts';

// The scene editor of issue #101 (docs/design.md, "Scene editor"): CodeMirror from
// /review/editor.js with three views of the same Markdown, and the plain text field of the
// first slice when that module does not load. Every save is checked against the bytes on disk.

const SCENE = 'scenes/escena-01.md';
const TITLE = 'La puerta de Sal';

function commitScene(book: Book, file: string, text: string): void {
  writeFileSync(join(book.dir, file), text);
  book.git('add', file);
  book.git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-q', '-m', `add ${file}`, '--', file);
}

async function openEditor(page: Page, book: Book, file = SCENE): Promise<void> {
  await page.goto(`${book.base}/review`);
  await page.getByRole('navigation', { name: 'Secciones' }).getByRole('link', { name: 'Navegar escenas', exact: true }).click();
  await page.getByRole('button', { name: file, exact: true }).click();
  await page.getByRole('button', { name: 'Editar escena' }).click();
}

const content = (page: Page) => page.getByRole('textbox', { name: /^Texto de la escena / });
const view = (page: Page, name: string) => page.getByRole('group', { name: 'Vista del editor' }).getByRole('button', { name, exact: true });
const firstLine = (page: Page) => page.locator('.cm-content .cm-line').first();

async function shoot(page: Page, name: string): Promise<void> {
  await page.locator('.scene-editor').screenshot({ path: test.info().outputPath(`${name}.png`) });
}

// Fails the test on any CSP report or script error the page logs.
function watchConsole(page: Page): string[] {
  const errors: string[] = [];
  page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
  page.on('pageerror', (error) => errors.push(error.message));
  return errors;
}

test('desktop: the three views show one Markdown text, typing in live preview saves the exact bytes, and the view is remembered', async ({ page, book }) => {
  const errors = watchConsole(page);
  const original = book.bytes(SCENE).toString('utf8');
  await openEditor(page, book);
  await expect(page.locator('.scene-editor .cm-editor')).toBeVisible();
  await expect(page.locator('.scene-editor textarea')).toHaveCount(0);
  await expect(view(page, 'Vista previa en vivo')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('.cm-gutters')).toHaveCount(0);

  // Type at the end, then leave the line: its markers hide and its emphasis stays.
  await content(page).click();
  await page.keyboard.press('Control+End');
  await page.keyboard.type('Un párrafo *nuevo*.');
  const last = page.locator('.cm-content .cm-line').last();
  await expect(last).toHaveText('Un párrafo *nuevo*.');
  await page.keyboard.press('Control+Home');
  await expect(last).toHaveText('Un párrafo nuevo.');
  await expect(last.locator('.cm-lp-em')).toHaveText('nuevo');
  await page.keyboard.press('ArrowDown');
  await expect(firstLine(page)).toHaveText(TITLE);
  await expect(firstLine(page)).toHaveClass(/cm-lp-h1/);
  await shoot(page, 'desktop-live');

  await page.keyboard.press('Control+s');
  await expect(page.locator('.save-status')).toHaveText('Guardado');
  const saved = original + 'Un párrafo *nuevo*.';
  expect(book.bytes(SCENE).toString('utf8')).toBe(saved);

  await view(page, 'Markdown').click();
  await expect(view(page, 'Markdown')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('.cm-lineNumbers')).toBeVisible();
  await expect(firstLine(page)).toHaveText(`# ${TITLE}`);
  await expect(page.locator('.cm-content .cm-line').last()).toHaveText('Un párrafo *nuevo*.');
  await shoot(page, 'desktop-markdown');

  await view(page, 'Lectura').click();
  const reading = page.locator('.scene-reading');
  await expect(reading.locator('h1')).toHaveText(TITLE);
  await expect(reading.locator('em', { hasText: 'nuevo' })).toBeVisible();
  await expect(page.locator('.scene-editor .cm-editor')).toBeHidden();
  await expect(reading.locator('[contenteditable]')).toHaveCount(0);
  await shoot(page, 'desktop-reading');

  // Switching views changed nothing: nothing unsaved, the bytes as saved.
  await expect(page.locator('.save-status')).toHaveText('Guardado');
  expect(book.bytes(SCENE).toString('utf8')).toBe(saved);
  await page.reload();
  await openEditor(page, book);
  await expect(view(page, 'Lectura')).toHaveAttribute('aria-pressed', 'true');
  expect(errors).toEqual([]);
});

const { defaultBrowserType: _phoneBrowser, ...phone } = devices['Pixel 7'];
test.describe('on a phone', () => {
  test.use(phone);

  test('typing, an IME composition and a save keep the bytes, at a size iOS does not zoom', async ({ page, book }) => {
    const errors = watchConsole(page);
    const original = book.bytes(SCENE).toString('utf8');
    await openEditor(page, book);
    await expect(view(page, 'Vista previa en vivo')).toHaveAttribute('aria-pressed', 'true');
    await expect(content(page)).toHaveAttribute('autocorrect', 'on');
    await expect(content(page)).toHaveAttribute('spellcheck', 'true');

    await content(page).tap();
    await page.keyboard.press('Control+End');
    await page.keyboard.type('Fin');
    // A keyboard that composes (an accent, a dictated word) through the IME.
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Input.imeSetComposition', { text: 'a', selectionStart: 1, selectionEnd: 1 });
    await cdp.send('Input.imeSetComposition', { text: 'á', selectionStart: 1, selectionEnd: 1 });
    await cdp.send('Input.insertText', { text: 'á' });
    await expect(page.locator('.cm-content .cm-line').last()).toHaveText('Finá');
    await shoot(page, 'phone-live');

    await page.getByRole('button', { name: 'Guardar', exact: true }).tap();
    await expect(page.locator('.save-status')).toHaveText('Guardado');
    expect(book.bytes(SCENE).toString('utf8')).toBe(original + 'Finá');

    for (const [name, shot] of [['Vista previa en vivo', 'phone-live'], ['Markdown', 'phone-markdown'], ['Lectura', 'phone-reading']] as const) {
      await view(page, name).tap();
      const sized = name === 'Lectura' ? page.locator('.scene-reading') : page.locator('.cm-content');
      const size = await sized.evaluate((node) => parseFloat(getComputedStyle(node).fontSize));
      expect(size, `${name}: text at 16 px or more`).toBeGreaterThanOrEqual(16);
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      expect(overflow, `${name}: no sideways scroll`).toBeLessThanOrEqual(0);
      if (shot !== 'phone-live') await shoot(page, shot);
    }
    expect(errors).toEqual([]);
  });
});

test('a CRLF scene edited in live preview is saved with CRLF everywhere', async ({ page, book }) => {
  const file = 'scenes/crlf.md';
  commitScene(book, file, '# Uno\r\n\r\nDos.\r\n');
  await openEditor(page, book, file);
  await content(page).click();
  await page.keyboard.press('Control+End');
  await page.keyboard.type('Tres.');
  await page.keyboard.press('Control+s');
  await expect(page.locator('.save-status')).toHaveText('Guardado');
  expect(book.bytes(file).toString('utf8')).toBe('# Uno\r\n\r\nDos.\r\nTres.');
});

test('a scene with mixed line endings opens read-only in CodeMirror until it is normalised', async ({ page, book }) => {
  const file = 'scenes/mixed.md';
  commitScene(book, file, 'a\r\nb\nc\n');
  const before = book.bytes(file);
  await openEditor(page, book, file);
  await expect(page.getByText('Esta escena mezcla finales de línea')).toBeVisible();
  await expect(content(page)).toHaveAttribute('contenteditable', 'false');
  await expect(page.getByRole('button', { name: 'Guardar', exact: true })).toBeHidden();
  await page.locator('.cm-content').click();
  await page.keyboard.type('zz');
  await page.keyboard.press('Control+s');
  await expect(page.locator('.cm-content')).not.toContainText('zz');
  expect(book.bytes(file).equals(before)).toBe(true);

  await page.getByRole('button', { name: 'Normalizar los finales de línea y editar' }).click();
  await expect(content(page)).toHaveAttribute('contenteditable', 'true');
  await page.getByRole('button', { name: 'Guardar', exact: true }).click();
  await expect(page.locator('.save-status')).toHaveText('Guardado, con los finales de línea normalizados.');
  expect(book.bytes(file).toString('utf8')).toBe('a\nb\nc\n');
});

test('when the editor module does not load, the plain text field of the first slice edits and saves', async ({ page, book }) => {
  await page.route('**/review/editor.js', (route) => route.fulfill({ status: 404, body: 'not found' }));
  const original = book.bytes(SCENE).toString('utf8');
  await openEditor(page, book);
  const area = page.locator('.scene-editor textarea');
  await expect(area).toBeVisible();
  await expect(page.locator('.cm-editor')).toHaveCount(0);
  await expect(page.getByRole('group', { name: 'Vista del editor' })).toHaveCount(0);
  await expect(area).toBeFocused();
  await page.keyboard.press('Control+End');
  await page.keyboard.type('Último.');
  await page.keyboard.press('Control+s');
  await expect(page.locator('.save-status')).toHaveText('Guardado');
  expect(book.bytes(SCENE).toString('utf8')).toBe(original + 'Último.');
});
