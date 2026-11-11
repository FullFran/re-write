import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { devices, type Page } from '@playwright/test';
import { expect, test, type Book } from '../fixtures.ts';

// Wikilinks in the editor and the book's notes and graph in the page (issue #115, slice 2;
// docs/notes-and-graph.md). Every save is checked against the bytes on disk. Screenshots of the
// editor with links, the completion list, a note with its backlinks and the graph list go to
// test-results/, on desktop and on a phone.

const SCENE = 'scenes/escena-01.md';
const OTHER = 'scenes/escena-02.md';
const LINKED = 'La capitana [[Elena]] llegó al [[Puerto de Sal|puerto]] y preguntó por [[Nadie]].';

function commit(book: Book, files: Record<string, string>): void {
  mkdirSync(join(book.dir, 'notas'), { recursive: true });
  for (const [file, text] of Object.entries(files)) writeFileSync(join(book.dir, file), text);
  book.git('add', ...Object.keys(files));
  book.git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-q', '-m', 'notes and links');
}

// Three notes (one an orphan), links from both scenes, and an unlinked mention in the second.
function setup(book: Book): void {
  commit(book, {
    'notas/Elena.md': '---\ntype: personaje\naliases: [la capitana]\n---\nGuarda el [[Puerto de Sal]].\n',
    'notas/Puerto de Sal.md': '---\ntype: lugar\n---\nUn muelle de piedra.\n',
    'notas/Brújula.md': '---\ntype: objeto\n---\nNadie la ha nombrado aún.\n',
    [SCENE]: book.bytes(SCENE).toString('utf8') + '\n' + LINKED + '\n',
    [OTHER]: book.bytes(OTHER).toString('utf8') + '\n[[Elena]] volvió sola al [[Puerto de Sal]].\n',
  });
}

const modeButton = (page: Page, name: string) => page.getByRole('group', { name: 'Modo' }).getByRole('button', { name, exact: true });
const sceneText = (page: Page) => page.getByRole('textbox', { name: /^Texto de la escena / });
const noteText = (page: Page, name: string) => page.getByRole('textbox', { name: `Texto de la nota ${name}` });
const tool = (page: Page, name: string) => page.getByRole('group', { name: 'Notas y grafo del libro' }).getByRole('button', { name, exact: true });
const linkedLine = (page: Page) => page.locator('.desk .cm-line', { hasText: 'llegó al' });

function watchConsole(page: Page): string[] {
  const errors: string[] = [];
  page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
  page.on('pageerror', (error) => errors.push(error.message));
  return errors;
}

async function shoot(page: Page, name: string): Promise<void> {
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' });
    await page.screenshot({ path: test.info().outputPath(`${name}-${scheme}.png`) });
  }
  await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'no-preference' });
}

async function openDesk(page: Page, book: Book, mode = 'Concentración'): Promise<void> {
  await page.goto(`${book.base}/review`);
  await modeButton(page, mode).click();
  await expect(sceneText(page)).toBeVisible();
  await expect(page.locator('.desk-title')).toHaveText('La puerta de Sal');
}

test('desktop: links read as their text away from the cursor, [[ completes notes and aliases, and the Markdown view shows them raw', async ({ page, book }) => {
  const errors = watchConsole(page);
  setup(book);
  await openDesk(page, book);

  // The cursor is on the first line: the link line shows only the links' text.
  await expect(linkedLine(page)).toHaveText('La capitana Elena llegó al puerto y preguntó por Nadie.');
  await expect(linkedLine(page).locator('.cm-wikilink', { hasText: 'puerto' })).toHaveAttribute('data-wikilink', 'Puerto de Sal');
  await expect(linkedLine(page).locator('.cm-wikilink-unresolved')).toHaveText('Nadie');
  await expect(linkedLine(page).locator('.cm-wikilink:not(.cm-wikilink-unresolved)')).toHaveCount(2);

  // On the cursor's line the brackets are back.
  await linkedLine(page).click({ position: { x: 2, y: 5 } });
  await expect(linkedLine(page)).toHaveText(LINKED);

  // [[ offers notes and aliases, ignoring case and accents; Enter takes the highlighted one.
  await sceneText(page).press('Control+End');
  await page.keyboard.type('Y [[CAPI');
  const options = page.locator('.cm-tooltip-autocomplete li');
  await expect(options).toHaveCount(1);
  await expect(options.first()).toContainText('la capitana');
  await expect(options.first()).toContainText('Elena');
  await shoot(page, 'desktop-autocomplete');
  await page.keyboard.press('Enter');
  await page.keyboard.type(' y [[brúj');
  await expect(options.first()).toContainText('Brújula');
  await page.keyboard.press('Enter');
  await page.keyboard.type('.');
  await page.keyboard.press('Control+s');
  await expect(page.locator('.desk .save-status')).toHaveText('Guardado');
  const saved = book.bytes(SCENE).toString('utf8');
  expect(saved.endsWith(LINKED + '\nY [[Elena|la capitana]] y [[Brújula]].')).toBe(true);
  await page.keyboard.press('Control+Home');
  await expect(page.locator('.desk .cm-line').last()).toHaveText('Y la capitana y Brújula.');
  await shoot(page, 'desktop-links');

  await page.getByRole('group', { name: 'Vista del editor' }).getByRole('button', { name: 'Markdown', exact: true }).click();
  await expect(linkedLine(page)).toHaveText(LINKED);
  await expect(page.locator('.desk .cm-wikilink')).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('desktop: a click on a link opens its note, Enter inside a link too, and a note shows its backlinks that lead to the scene', async ({ page, book }) => {
  const errors = watchConsole(page);
  setup(book);
  await openDesk(page, book, 'Ayuda RE;write');

  // A click on a link shown as text opens the note in the same editor.
  await linkedLine(page).locator('.cm-wikilink', { hasText: 'puerto' }).click();
  await expect(noteText(page, 'Puerto de Sal')).toBeVisible();
  await expect(page.locator('.desk-title')).toHaveText('Puerto de Sal');
  await expect(page.getByRole('combobox', { name: 'Escena', exact: true })).toHaveValue('');

  // An unresolved link says so and opens nothing.
  await page.getByRole('combobox', { name: 'Escena', exact: true }).selectOption(SCENE);
  await expect(sceneText(page)).toBeVisible();
  await linkedLine(page).locator('.cm-wikilink-unresolved').click();
  await expect(page.locator('.desk-status')).toHaveText('Ninguna nota se llama «Nadie». El asistente puede proponerla.');
  await expect(sceneText(page)).toBeVisible();

  // Enter with the cursor inside a link follows it.
  await linkedLine(page).click({ position: { x: 2, y: 5 } });
  await page.keyboard.press('Home');
  for (let i = 0; i < 'La capitana [[El'.length; i++) await page.keyboard.press('ArrowRight');
  await page.keyboard.press('Enter');
  await expect(noteText(page, 'Elena')).toBeVisible();
  expect(book.bytes(SCENE).toString('utf8')).toContain(LINKED);

  const mentions = page.getByRole('region', { name: 'Menciones de Elena' });
  await expect(mentions.getByRole('heading', { name: 'Menciones enlazadas (2)' })).toBeVisible();
  await expect(mentions.getByRole('heading', { name: /^Menciones sin enlazar \(\d+\)$/ })).toBeVisible();
  await expect(mentions.locator('.mention-context').first()).toContainText('La capitana [[Elena]] llegó al');
  await shoot(page, 'desktop-note-backlinks');

  // A person edits the note and saves it through the same path as a scene.
  await noteText(page, 'Elena').press('Control+End');
  await page.keyboard.type('Capitana del puerto.');
  await page.keyboard.press('Control+s');
  await expect(page.locator('.desk .save-status')).toHaveText('Guardado');
  expect(book.bytes('notas/Elena.md').toString('utf8')).toBe('---\ntype: personaje\naliases: [la capitana]\n---\nGuarda el [[Puerto de Sal]].\nCapitana del puerto.');
  expect(book.git('log', '-1', '--format=%s')).toMatch(/Elena/);

  // A linked mention opens the scene with the link selected.
  await mentions.getByRole('button', { name: /^Ir a la mención en escena-02, línea \d+$/ }).first().click();
  await expect(sceneText(page)).toBeVisible();
  await expect(page.getByRole('combobox', { name: 'Escena', exact: true })).toHaveValue(OTHER);
  await expect.poll(() => page.evaluate(() => document.getSelection()?.toString())).toBe('[[Elena]]');
  expect(errors).toEqual([]);
});

test('desktop: Notas lists the notes by type in both writing modes, and Grafo is a sortable table reachable from the keyboard', async ({ page, book }) => {
  const errors = watchConsole(page);
  setup(book);
  for (const mode of ['Concentración', 'Ayuda RE;write']) {
    await openDesk(page, book, mode);
    await tool(page, 'Notas').click();
    await expect(tool(page, 'Notas')).toHaveAttribute('aria-expanded', 'true');
    const panel = page.locator('#desk-panel');
    await expect(panel.getByRole('heading', { name: 'Personajes (1)' })).toBeVisible();
    await expect(panel.getByRole('heading', { name: 'Lugares (1)' })).toBeVisible();
    await expect(panel.getByRole('heading', { name: 'Objetos (1)' })).toBeVisible();
    await expect(panel).toContainText('también: la capitana');
    await expect(sceneText(page)).toBeHidden();
    await panel.getByRole('button', { name: 'Brújula', exact: true }).click();
    await expect(noteText(page, 'Brújula')).toBeVisible();
    await expect(tool(page, 'Notas')).toHaveAttribute('aria-expanded', 'false');
  }

  await tool(page, 'Grafo').click();
  const table = page.getByRole('table', { name: 'Nodos del grafo' });
  const names = () => table.locator('tbody .graph-node').allTextContents();
  await expect.poll(names).toEqual(['Elena', 'Puerto de Sal', 'Brújula']);
  await expect(table.getByRole('columnheader', { name: 'Grado' })).toHaveAttribute('aria-sort', 'descending');
  await table.getByRole('button', { name: 'Nodo', exact: true }).click();
  await expect.poll(names).toEqual(['Brújula', 'Elena', 'Puerto de Sal']);
  await expect(table.getByRole('columnheader', { name: 'Nodo' })).toHaveAttribute('aria-sort', 'ascending');

  // Arrows move between nodes, Enter chooses one: its neighbours are listed and it is announced.
  await table.getByRole('button', { name: 'Brújula', exact: true }).focus();
  await page.keyboard.press('ArrowDown');
  await expect(table.getByRole('button', { name: 'Elena', exact: true })).toBeFocused();
  await page.keyboard.press('End');
  await expect(table.getByRole('button', { name: 'Puerto de Sal', exact: true })).toBeFocused();
  await page.keyboard.press('ArrowUp');
  await page.keyboard.press('Enter');
  await expect(table.getByRole('button', { name: 'Elena', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('.graph-live')).toHaveText('Elegido: Elena, personaje, grado 3.');
  const detail = page.getByRole('region', { name: 'Vecinos del nodo elegido' });
  await expect(detail.getByRole('heading', { name: 'Vecinos de Elena (3)' })).toBeVisible();
  await expect(detail.getByRole('listitem')).toHaveCount(1);
  await expect(detail).toContainText('Puerto de Sal');
  await expect(detail).toContainText('coinciden en 2 escenas');
  await expect(detail).toContainText('Y 2 escenas ocultas');
  await shoot(page, 'desktop-graph-list');

  // Scenes on request, and the graph as of the first scene leaves the second out.
  await page.getByRole('checkbox', { name: 'Mostrar escenas' }).check();
  await expect.poll(async () => (await names()).length).toBe(5);
  await page.getByRole('slider', { name: 'Hasta la escena' }).focus();
  await page.keyboard.press('Home');
  await expect.poll(names).toEqual(['Brújula', 'Elena', 'escena-01', 'Puerto de Sal']);
  await expect(table.getByRole('row', { name: /^Elena/ })).toContainText('Personaje21');

  await detail.getByRole('button', { name: 'Abrir Elena' }).click();
  await expect(noteText(page, 'Elena')).toBeVisible();
  expect(errors).toEqual([]);
});

const { defaultBrowserType: _phoneBrowser, ...phone } = devices['Pixel 7'];
test.describe('phone', () => {
  test.use(phone);

  test('phone: links, a note with its backlinks and the graph list fit the screen with 44 px targets', async ({ page, book }) => {
    const errors = watchConsole(page);
    setup(book);
    await openDesk(page, book);
    await expect(linkedLine(page).locator('.cm-wikilink', { hasText: 'puerto' })).toBeVisible();
    await shoot(page, 'phone-links');
    await linkedLine(page).locator('.cm-wikilink', { hasText: 'Elena' }).tap();
    await expect(noteText(page, 'Elena')).toBeVisible();
    await page.getByRole('region', { name: 'Menciones de Elena' }).scrollIntoViewIfNeeded();
    await shoot(page, 'phone-note-backlinks');

    await tool(page, 'Grafo').tap();
    const table = page.getByRole('table', { name: 'Nodos del grafo' });
    await expect(table.locator('tbody .graph-node')).toHaveCount(3);
    for (const target of [tool(page, 'Grafo'), table.locator('tbody .graph-node').first(), page.getByRole('button', { name: 'Volver al texto' })]) {
      const box = await target.boundingBox();
      expect(box!.height).toBeGreaterThanOrEqual(44);
    }
    const width = await page.evaluate(() => document.documentElement.scrollWidth);
    expect(width).toBeLessThanOrEqual(page.viewportSize()!.width);
    await table.locator('tbody .graph-node').first().tap();
    await expect(page.locator('.graph-live')).toHaveText(/^Elegido: Elena/);
    await shoot(page, 'phone-graph-list');
    await page.getByRole('button', { name: 'Volver al texto' }).tap();
    await expect(noteText(page, 'Elena')).toBeVisible();
    expect(errors).toEqual([]);
  });
});
