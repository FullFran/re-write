import type { Page } from '@playwright/test';
import { expect, test, type Book } from '../fixtures.ts';

// The assistant panel of the review page (docs/design.md, "Assistant panel") against the
// real server with the engine on and a stand-in engine process that calls no model.

test.use({ engine: true });

const PHONE = { width: 390, height: 844 };
const DESKTOP = { width: 1280, height: 800 };
const SCENE = 'scenes/escena-01.md';

async function open(page: Page, book: Book): Promise<void> {
  await page.goto(`${book.base}/review`);
  await expect(page.getByRole('navigation', { name: 'Secciones' })).toBeVisible();
}

// Device login inside the panel: the code, the fixed OpenAI address, then the quick questions.
async function connect(page: Page): Promise<void> {
  const panel = page.getByRole('complementary', { name: 'Asistente' });
  await panel.getByRole('button', { name: 'Conectar ChatGPT' }).click();
  await expect(panel.getByText('ECHO-1234')).toBeVisible();
  await expect(panel.getByRole('link', { name: 'Abrir OpenAI' })).toHaveAttribute('href', 'https://auth.openai.com/codex/device');
  await expect(panel.getByText('Esperando a que confirmes en OpenAI…')).toBeVisible();
  await expect(panel.getByRole('button', { name: 'Busca incoherencias en el libro' })).toBeVisible({ timeout: 10_000 });
}

test('on a desktop the panel opens beside the page, connects, and streams a formatted answer with steps', async ({ page, book }) => {
  await page.setViewportSize(DESKTOP);
  await open(page, book);
  const panel = page.getByRole('complementary', { name: 'Asistente' });
  await expect(panel).toBeHidden();
  await page.locator('#assistant-toggle').click();
  await expect(panel).toBeVisible();

  // A side column: the page column stays fully visible to its left.
  const side = (await panel.boundingBox())!;
  const main = (await page.locator('main').boundingBox())!;
  expect(side.x + side.width).toBeCloseTo(DESKTOP.width, 0);
  expect(side.height).toBeCloseTo(DESKTOP.height, 0);
  expect(main.x + main.width).toBeLessThanOrEqual(side.x + 1);
  await expect(panel.getByText('La puerta de Sal')).toBeVisible();

  await connect(page);
  await panel.getByRole('button', { name: 'Resume los cambios pendientes' }).click();
  await expect(panel.getByRole('textbox', { name: 'Mensaje para el asistente' })).toHaveValue('Resume los cambios pendientes');
  await panel.getByRole('button', { name: 'Enviar' }).click();

  const answer = panel.locator('.answer');
  await expect(answer).toContainText('[RE;write page context, set by the host] book_id="sal" title="La puerta de Sal"');
  await expect(answer.locator('strong')).toHaveText('Recibido:');
  await expect(answer.locator('li')).toHaveText(['uno', 'dos']);
  await expect(panel.locator('.activity li')).toHaveText(['Leída: escena 01']);

  await page.keyboard.press('Escape');
  await expect(panel).toBeHidden();
  await expect(page.locator('#assistant-toggle')).toBeFocused();
});

test('on a phone the floating button opens a bottom sheet, and asking about a proposal sends its id', async ({ page, book }) => {
  const id = book.cli('propose', '--file', SCENE, '--find', 'Fuera empezaba a llover', '--replace', 'Fuera arreciaba la tormenta', '--rationale', 'Una imagen más intensa').proposal.proposal_id;
  await page.setViewportSize(PHONE);
  await open(page, book);
  const panel = page.getByRole('complementary', { name: 'Asistente' });
  const fab = page.locator('.assistant-fab');
  await expect(fab).toBeVisible();
  await expect(fab).toHaveAccessibleName('Asistente');

  // Scrolling the page never puts the floating button over an accept/reject bar.
  for (let y = 0; y <= 1500; y += 50) {
    // The button is placed on the next frame after a scroll, as in a real scroll.
    await page.evaluate((top) => new Promise((done) => {
      window.scrollTo(0, top);
      requestAnimationFrame(() => requestAnimationFrame(done));
    }), y);
    const overlap = await page.evaluate(() => {
      const f = document.querySelector('.assistant-fab')!.getBoundingClientRect();
      let worst = 0;
      for (const bar of document.querySelectorAll('.decision')) {
        const d = bar.getBoundingClientRect();
        if (d.right > f.left && d.left < f.right) worst = Math.max(worst, Math.min(f.bottom, d.bottom) - Math.max(f.top, d.top));
      }
      return worst;
    });
    expect(overlap, `scrolled to ${y}`).toBeLessThanOrEqual(0);
  }
  await page.evaluate(() => window.scrollTo(0, 0));

  await fab.click();
  await expect(panel).toBeVisible();
  const sheet = (await panel.boundingBox())!;
  expect(sheet.x).toBe(0);
  expect(sheet.width).toBeCloseTo(PHONE.width, 0);
  expect(sheet.y + sheet.height).toBeCloseTo(PHONE.height, 0);
  await connect(page);
  await panel.getByRole('button', { name: 'Cerrar el asistente' }).click();
  await expect(panel).toBeHidden();

  const card = page.locator(`[data-item="proposal:${id}"]`).first();
  await card.getByRole('button', { name: /Preguntar al asistente/ }).click();
  await expect(panel).toBeVisible();
  const input = panel.getByRole('textbox', { name: 'Mensaje para el asistente' });
  await expect(input).toHaveValue(/Qué gana la escena con este cambio/);
  await expect(panel.getByText('Cambio propuesto · escena-01.md')).toBeVisible();
  await expect(input).toHaveCSS('font-size', '16px');
  await panel.getByRole('button', { name: 'Enviar' }).click();
  await expect(panel.locator('.answer')).toContainText(`item=proposal id="${id}" scene="${SCENE}"`);
});

test('the old assistant address opens the panel in the review page', async ({ page, book }) => {
  await page.setViewportSize(DESKTOP);
  await page.goto(`${book.base}/review/engine`);
  // The panel flag leaves the address; the chosen book (issue #103) is recorded in it.
  await expect(page).toHaveURL(`${book.base}/review?book=${book.book}`);
  await expect(page.getByRole('complementary', { name: 'Asistente' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Conectar ChatGPT' })).toBeVisible();
});

// Issue #99: before any code, the panel says which account does what, and both states.
for (const [name, size] of [['phone', PHONE], ['desktop', DESKTOP]] as const) {
  test(`on a ${name}, a writer who is not connected sees what each account is for before the code`, async ({ page, book }) => {
    await page.setViewportSize(size);
    await open(page, book);
    await (name === 'phone' ? page.locator('.assistant-fab') : page.locator('#assistant-toggle')).click();
    const panel = page.getByRole('complementary', { name: 'Asistente' });
    await expect(panel.getByText('RE;write: sesión iniciada')).toBeVisible();
    await expect(panel.getByText('ChatGPT: sin conectar')).toBeVisible();
    await expect(panel.getByRole('heading', { name: 'Qué necesitas' })).toBeVisible();
    await expect(panel).toContainText('Tu cuenta de RE;write basta para crear libros, importar capítulos y revisar sugerencias.');
    await expect(panel).toContainText('Para hablar con el asistente aquí también necesitas tu propia cuenta de ChatGPT.');
    await expect(panel).toContainText('Nunca escribas tu contraseña en RE;write.');
    await expect(panel).toContainText('También puedes usar RE;write desde tu propio ChatGPT con el conector de RE;write.');
    await expect(panel.getByRole('button', { name: 'Conectar ChatGPT' })).toBeVisible();
    await page.screenshot({ path: test.info().outputPath(`not-connected-${name}.png`) });

    await connect(page);
    await expect(panel.getByText('RE;write: sesión iniciada')).toBeVisible();
    await expect(panel.getByText('ChatGPT: conectado')).toBeVisible();
    await expect(panel.getByRole('heading', { name: 'Qué necesitas' })).toHaveCount(0);
  });
}
