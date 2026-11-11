import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { devices, type Page, type Request } from '@playwright/test';
import { expect, test, type Book } from '../fixtures.ts';

// The Grafo drawing (issue #115, slice 3; docs/notes-and-graph.md): a chunk loaded only when the
// drawing opens, the selection shared with the table, the Análisis operations, the as_of_scene
// slider, a missing chunk, phones, and 2,000 nodes. Screenshots of the drawing with communities
// and a highlighted path go to test-results/, light and dark, on desktop and on a phone.

const SCENE = 'scenes/escena-01.md';
const OTHER = 'scenes/escena-02.md';

function commit(book: Book, files: Record<string, string>): void {
  mkdirSync(join(book.dir, 'notas'), { recursive: true });
  for (const [file, text] of Object.entries(files)) writeFileSync(join(book.dir, file), text);
  book.git('add', ...Object.keys(files));
  book.git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-q', '-m', 'notes and links');
}

// Five notes: Tomás links Isla, Isla links Elena, Elena and Puerto de Sal share both scenes, and
// Brújula is an orphan. The only path from Tomás to Puerto de Sal is Tomás, Isla, Elena, Puerto.
function setup(book: Book): void {
  commit(book, {
    'notas/Elena.md': '---\ntype: personaje\naliases: [la capitana]\n---\nCapitana.\n',
    'notas/Puerto de Sal.md': '---\ntype: lugar\n---\nUn muelle de piedra.\n',
    'notas/Brújula.md': '---\ntype: objeto\n---\nNadie la ha nombrado aún.\n',
    'notas/Tomás.md': '---\ntype: personaje\n---\nVive en [[Isla]].\n',
    'notas/Isla.md': '---\ntype: lugar\n---\nAllí nació [[Elena]].\n',
    [SCENE]: book.bytes(SCENE).toString('utf8') + '\n[[Elena]] llegó al [[Puerto de Sal]].\n',
    [OTHER]: book.bytes(OTHER).toString('utf8') + '\n[[Elena]] volvió sola al [[Puerto de Sal]].\n',
  });
}

const modeButton = (page: Page, name: string) => page.getByRole('group', { name: 'Modo' }).getByRole('button', { name, exact: true });
const sceneText = (page: Page) => page.getByRole('textbox', { name: /^Texto de la escena / });
const tool = (page: Page, name: string) => page.getByRole('group', { name: 'Notas y grafo del libro' }).getByRole('button', { name, exact: true });
const canvas = (page: Page) => page.locator('.graph-canvas');
const table = (page: Page) => page.getByRole('table', { name: 'Nodos del grafo' });
const rowNames = (page: Page) => table(page).locator('tbody .graph-node').allTextContents();
const analysis = (page: Page) => page.locator('details.graph-analysis');

function watchConsole(page: Page): string[] {
  const errors: string[] = [];
  page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
  page.on('pageerror', (error) => errors.push(error.message));
  return errors;
}

function watchChunks(page: Page): string[] {
  const chunks: string[] = [];
  page.on('request', (request: Request) => {
    const path = new URL(request.url()).pathname;
    if (path.startsWith('/review/chunks/')) chunks.push(path.slice('/review/chunks/'.length).replace(/-[A-Z0-9]+\.js$/, ''));
  });
  return chunks;
}

async function shoot(page: Page, name: string): Promise<void> {
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' });
    await page.waitForTimeout(300);
    await page.screenshot({ path: test.info().outputPath(`${name}-${scheme}.png`), fullPage: true });
  }
  await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'no-preference' });
}

async function openDesk(page: Page, book: Book): Promise<void> {
  await page.goto(`${book.base}/review`);
  await modeButton(page, 'Ayuda RE;write').click();
  await expect(sceneText(page)).toBeVisible();
}

test('desktop: the drawing loads only when Grafo opens, shares the selection with the table and highlights a shortest path', async ({ page, book }) => {
  const errors = watchConsole(page);
  const chunks = watchChunks(page);
  setup(book);
  await openDesk(page, book);
  await tool(page, 'Notas').click();
  await expect(page.locator('#desk-panel')).toContainText('Personajes (2)');
  expect(chunks, 'the editor and Notas never fetch the graph code').toEqual([]);

  await tool(page, 'Grafo').click();
  await expect(canvas(page)).toHaveAttribute('data-layout', 'done');
  expect(chunks).toEqual(['graph-view', 'layout-worker']);
  await expect(canvas(page)).toHaveAttribute('data-nodes', '5');
  await expect(canvas(page)).toHaveAttribute('aria-label', 'Dibujo del grafo: 5 nodos y 3 conexiones. La tabla tiene los mismos datos.');
  await expect(page.locator('.graph-canvas canvas').first()).toBeVisible();
  await expect.poll(() => rowNames(page)).toEqual(['Elena', 'Puerto de Sal', 'Isla', 'Tomás', 'Brújula']);

  // A row chosen in the table marks the node in the drawing, and is announced.
  await table(page).getByRole('button', { name: 'Isla', exact: true }).click();
  await expect(canvas(page)).toHaveAttribute('data-selected', 'note:Isla');
  await expect(page.locator('.graph-live')).toHaveText('Elegido: Isla, lugar, grado 2.');

  // Análisis: rankings with values, communities, orphans and components, and suggestions.
  await expect(analysis(page)).toHaveAttribute('open', '');
  const centrality = analysis(page).getByRole('region', { name: 'Centralidad' });
  await expect(centrality.locator('.graph-ranking li').first()).toHaveText(/^Elena 2$/);
  await centrality.getByRole('combobox', { name: 'Ordenar por' }).selectOption('betweenness');
  await expect(centrality.locator('.graph-ranking li').first()).toHaveText(/^Elena 0,\d{3}$/);
  await expect(analysis(page).getByRole('region', { name: 'Comunidades' }).locator('.graph-communities > li').first()).toContainText('Comunidad 1');
  await expect(analysis(page).getByRole('region', { name: 'Huérfanas y componentes' })).toContainText('2 componentes; el mayor tiene 4 nodos. 1 nodo sin conexiones');
  const suggested = analysis(page).getByRole('region', { name: 'Enlaces sugeridos' });
  await expect(suggested.locator('li').first()).toContainText('comparten 1 vecino');
  // A name in an Análisis list chooses the node in the table too.
  await analysis(page).getByRole('region', { name: 'Huérfanas y componentes' }).getByRole('button', { name: 'Brújula' }).click();
  await expect(table(page).getByRole('button', { name: 'Brújula', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(canvas(page)).toHaveAttribute('data-selected', 'note:Brújula');

  // The shortest path between two chosen nodes is highlighted in the drawing and the table.
  const path = analysis(page).getByRole('region', { name: 'Camino más corto' });
  await path.getByRole('combobox', { name: 'Desde' }).selectOption({ label: 'Tomás' });
  await path.getByRole('combobox', { name: 'Hasta' }).selectOption({ label: 'Puerto de Sal' });
  await path.getByRole('button', { name: 'Buscar camino' }).click();
  await expect(canvas(page)).toHaveAttribute('data-path', 'note:Tomás\nnote:Isla\nnote:Elena\nnote:Puerto de Sal');
  await expect(path.getByRole('list', { name: 'Camino' }).getByRole('listitem')).toHaveText(['Tomás', 'Isla', 'Elena', 'Puerto de Sal']);
  await expect(page.locator('.graph-live')).toHaveText('Camino de Tomás a Puerto de Sal: 3 pasos, por Tomás, Isla, Elena, Puerto de Sal.');
  await expect(table(page).locator('tr.on-path')).toHaveCount(4);
  await page.locator('.graph-view').scrollIntoViewIfNeeded();
  await shoot(page, 'desktop-graph-path');

  // An orphan has no path; clearing the path clears the marks.
  await path.getByRole('button', { name: 'Quitar camino' }).click();
  await expect(canvas(page)).toHaveAttribute('data-path', '');
  await expect(table(page).locator('tr.on-path')).toHaveCount(0);
  await path.getByRole('combobox', { name: 'Hasta' }).selectOption({ label: 'Brújula' });
  await path.getByRole('button', { name: 'Buscar camino' }).click();
  await expect(path).toContainText('No hay camino entre Tomás y Brújula con estos filtros.');

  // Colour by type, size by PageRank.
  await page.getByRole('combobox', { name: 'Color' }).selectOption('type');
  await expect(page.getByRole('list', { name: 'Leyenda de colores' }).getByRole('listitem')).toHaveText(['Personaje', 'Lugar', 'Objeto']);
  await page.getByRole('combobox', { name: 'Tamaño' }).selectOption('pagerank');
  await page.getByRole('combobox', { name: 'Color' }).selectOption('community');
  await expect(page.getByRole('list', { name: 'Leyenda de colores' }).getByRole('listitem').first()).toHaveText(/^Comunidad 1: /);
  await shoot(page, 'desktop-graph-communities');
  expect(errors).toEqual([]);
});

test('desktop: a click on a drawn node chooses its row, and the filters, the local graph and the scene slider cut the drawing', async ({ page, book }) => {
  const errors = watchConsole(page);
  setup(book);
  await openDesk(page, book);
  await tool(page, 'Grafo').click();
  await expect(canvas(page)).toHaveAttribute('data-layout', 'done');

  // Only the orphan is left, drawn in the middle of the canvas: a click there chooses it.
  await page.getByRole('checkbox', { name: 'Solo huérfanas' }).check();
  await expect(canvas(page)).toHaveAttribute('data-nodes', '1');
  await expect.poll(() => rowNames(page)).toEqual(['Brújula']);
  await canvas(page).scrollIntoViewIfNeeded();
  await page.waitForTimeout(500);
  const box = (await canvas(page).boundingBox())!;
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await expect(table(page).getByRole('button', { name: 'Brújula', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('.graph-live')).toHaveText('Elegido: Brújula, objeto, grado 0.');
  await page.getByRole('checkbox', { name: 'Solo huérfanas' }).uncheck();

  // Types: without Lugar, Isla and Puerto de Sal leave both views.
  await page.getByRole('group', { name: 'Tipos' }).getByRole('checkbox', { name: 'Lugar' }).uncheck();
  await expect.poll(() => rowNames(page)).toEqual(['Elena', 'Tomás', 'Brújula']);
  await expect(canvas(page)).toHaveAttribute('data-nodes', '3');
  await page.getByRole('group', { name: 'Tipos' }).getByRole('checkbox', { name: 'Lugar' }).check();

  // The local graph around Tomás, depth 1 then 2; the table keeps every node.
  await table(page).getByRole('button', { name: 'Tomás', exact: true }).click();
  await page.getByRole('combobox', { name: 'Alcance' }).selectOption('local');
  const depth = page.getByRole('slider', { name: 'Profundidad' });
  await depth.focus();
  await page.keyboard.press('Home');
  await expect(canvas(page)).toHaveAttribute('data-nodes', '2');
  await page.keyboard.press('ArrowRight');
  await expect(canvas(page)).toHaveAttribute('data-nodes', '3');
  await expect.poll(async () => (await rowNames(page)).length).toBe(5);
  await page.getByRole('combobox', { name: 'Alcance' }).selectOption('global');

  // The scene slider: as of the first scene, the second leaves the drawing and the table.
  await page.getByRole('checkbox', { name: 'Mostrar escenas' }).check();
  await expect(canvas(page)).toHaveAttribute('data-nodes', '7');
  const slider = page.getByRole('slider', { name: 'Hasta la escena' });
  await expect(slider).toHaveAttribute('aria-valuetext', '2 de 2: escena-02');
  await slider.focus();
  await page.keyboard.press('Home');
  await expect(slider).toHaveAttribute('aria-valuetext', '1 de 2: escena-01');
  await expect(canvas(page)).toHaveAttribute('data-nodes', '6');
  await expect.poll(() => rowNames(page)).not.toContain('escena-02');
  expect(await rowNames(page)).toContain('escena-01');
  await page.keyboard.press('End');
  await expect(canvas(page)).toHaveAttribute('data-nodes', '7');
  expect(errors).toEqual([]);
});

test('without the graph chunk the drawing says so, the table works, and the editor still loads and saves', async ({ page, book }) => {
  setup(book);
  await page.route('**/review/chunks/**', (route) => route.fulfill({ status: 404, body: 'not found' }));
  await openDesk(page, book);
  await tool(page, 'Grafo').click();
  await expect(page.locator('.graph-view-error')).toHaveText('No se pudo cargar el dibujo del grafo. La tabla tiene los mismos datos.');
  await expect.poll(() => rowNames(page)).toEqual(['Elena', 'Puerto de Sal', 'Isla', 'Tomás', 'Brújula']);
  await table(page).getByRole('button', { name: 'Elena', exact: true }).click();
  await expect(page.locator('.graph-live')).toHaveText('Elegido: Elena, personaje, grado 4.');

  await page.getByRole('button', { name: 'Volver al texto' }).click();
  await expect(page.locator('.desk .cm-content')).toBeVisible();
  await sceneText(page).press('Control+End');
  await page.keyboard.type(' Fin.');
  await page.keyboard.press('Control+s');
  await expect(page.locator('.desk .save-status')).toHaveText('Guardado');
  expect(book.bytes(SCENE).toString('utf8').endsWith('[[Elena]] llegó al [[Puerto de Sal]].\n Fin.')).toBe(true);
});

const { defaultBrowserType: _phoneBrowser, ...phone } = devices['Pixel 7'];
test.describe('phone', () => {
  test.use(phone);

  test('phone: Grafo starts as the list without the graph code, and the drawing starts local with 44 px controls', async ({ page, book }) => {
    const errors = watchConsole(page);
    const chunks = watchChunks(page);
    setup(book);
    await openDesk(page, book);
    await tool(page, 'Grafo').tap();
    await expect.poll(async () => (await rowNames(page)).length).toBe(5);
    await expect(page.locator('.graph-canvas')).toHaveCount(0);
    expect(chunks).toEqual([]);

    await page.getByRole('checkbox', { name: 'Dibujo' }).check();
    await expect(canvas(page)).toHaveAttribute('data-layout', 'done');
    await expect(page.getByRole('combobox', { name: 'Alcance' })).toHaveValue('local');
    // Centred on the open scene: the scene, its two notes and Isla, two steps away.
    await expect(canvas(page)).toHaveAttribute('data-nodes', '4');
    await expect(analysis(page)).not.toHaveAttribute('open', '');
    for (const target of [
      page.getByRole('combobox', { name: 'Alcance' }), page.getByRole('slider', { name: 'Profundidad' }),
      page.getByRole('slider', { name: 'Hasta la escena' }), page.getByRole('button', { name: 'Acercar' }),
      page.locator('.graph-analysis > summary'), table(page).locator('tbody .graph-node').first(),
    ]) {
      const box = await target.boundingBox();
      expect(box!.height).toBeGreaterThanOrEqual(44);
    }
    const width = await page.evaluate(() => document.documentElement.scrollWidth);
    expect(width).toBeLessThanOrEqual(page.viewportSize()!.width);

    // A tap on the canvas background chooses nothing; the path search works by touch.
    const box = (await canvas(page).boundingBox())!;
    await page.touchscreen.tap(box.x + 20, box.y + 20);
    await page.locator('.graph-analysis > summary').tap();
    await analysis(page).getByRole('region', { name: 'Camino más corto' }).getByRole('combobox', { name: 'Desde' }).selectOption({ label: 'Isla' });
    await analysis(page).getByRole('region', { name: 'Camino más corto' }).getByRole('combobox', { name: 'Hasta' }).selectOption({ label: 'Puerto de Sal' });
    await analysis(page).getByRole('button', { name: 'Buscar camino' }).tap();
    await expect(canvas(page)).toHaveAttribute('data-path', 'note:Isla\nnote:Elena\nnote:Puerto de Sal');
    await canvas(page).scrollIntoViewIfNeeded();
    await shoot(page, 'phone-graph-path');
    expect(errors).toEqual([]);
  });
});

// A synthetic book of 2,000 notes (types in turn, each linked to the next three and co-occurring
// with a far one), served in place of the review door's graph data. Timing runs only in CI.
function bigGraph(size: number) {
  const types = ['personaje', 'lugar', 'objeto', 'trama', 'otra'];
  const id = (i: number) => 'note:Nota ' + String(i).padStart(4, '0');
  const edges: { kind: string; from: string; to: string; weight: number }[] = [];
  const degree = new Array(size).fill(0);
  const add = (kind: string, a: number, b: number, weight: number) => {
    edges.push({ kind, from: id(a), to: id(b), weight });
    degree[a]++;
    degree[b]++;
  };
  for (let i = 0; i < size; i++) {
    for (let k = 1; k <= 3; k++) if (i + k < size && (i + k) % 50 !== 0) add('link', i, i + k, 1);
    if (i % 7 === 0) add('cooccurs', i, (i * 37 + 11) % size === i ? (i + 1) % size : (i * 37 + 11) % size, 1 + (i % 4));
  }
  const nodes = Array.from({ length: size }, (_, i) => ({ id: id(i), kind: 'note', name: 'Nota ' + String(i).padStart(4, '0'), type: types[i % 5], order: null, degree: degree[i], scenes: i % 3 }));
  return { nodes, edges, scenes: [SCENE, OTHER], as_of_scene: null, too_large: [] };
}

test('performance: 2,000 nodes draw and lay out, and the table and the drawing answer a choice within a second', async ({ page, book }) => {
  test.setTimeout(180_000);
  const errors = watchConsole(page);
  const data = JSON.stringify(bigGraph(2000));
  await page.route('**/review/api/books/*/graph*', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: data }));
  await openDesk(page, book);
  await page.evaluate(() => {
    (window as any).longTasks = [];
    new PerformanceObserver((list) => list.getEntries().forEach((entry) => (window as any).longTasks.push(entry.duration))).observe({ type: 'longtask', buffered: true });
  });
  const opened = Date.now();
  await tool(page, 'Grafo').click();
  await expect(canvas(page)).toHaveAttribute('data-nodes', '2000', { timeout: 60_000 });
  const drawnMs = Date.now() - opened;
  await expect(canvas(page)).toHaveAttribute('data-layout', 'done', { timeout: 120_000 });
  const laidOutMs = Date.now() - opened;

  // A choice in the table, then marked in the drawing (the page announces it).
  const choose = async (index: number) => {
    const pick = table(page).locator('tbody .graph-node').nth(index);
    const name = (await pick.textContent())!;
    const started = Date.now();
    await pick.click();
    await expect(pick).toHaveAttribute('aria-pressed', 'true');
    const rowMs = Date.now() - started;
    await expect(canvas(page)).toHaveAttribute('data-selected', 'note:' + name);
    return { rowMs, drawingMs: Date.now() - started };
  };
  // The first choice brings the first highlighted frame. In CI, WebGL runs on SwiftShader, which
  // compiles each new drawing state on first use; that one-off cost is reported, not asserted.
  const first = await choose(10);
  const steady = [];
  for (const index of [20, 30, 40, 50, 60]) steady.push(await choose(index));
  // A filter that removes a fifth of the nodes redraws from cached positions.
  const filtered = Date.now();
  await page.getByRole('group', { name: 'Tipos' }).getByRole('checkbox', { name: 'Otra' }).uncheck();
  await expect(canvas(page)).toHaveAttribute('data-nodes', '1600');
  const filterMs = Date.now() - filtered;
  const longTasks: number[] = await page.evaluate(() => (window as any).longTasks);
  const metrics = {
    nodes: 2000, edges: JSON.parse(data).edges.length, drawnMs, laidOutMs, firstChoice: first,
    choiceRowMsMax: Math.max(...steady.map((s) => s.rowMs)), choiceDrawingMsMax: Math.max(...steady.map((s) => s.drawingMs)),
    filterMs, longTasks: longTasks.length, longestTaskMs: Math.round(Math.max(0, ...longTasks)),
  };
  console.log('graph performance ' + JSON.stringify(metrics));
  test.info().annotations.push({ type: 'graph performance', description: JSON.stringify(metrics) });
  expect(metrics.choiceRowMsMax).toBeLessThan(1000);
  expect(metrics.choiceDrawingMsMax).toBeLessThan(1000);
  expect(filterMs).toBeLessThan(5000);
  expect(errors).toEqual([]);
});
