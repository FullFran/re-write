import type { Page, Request } from '@playwright/test';
import { expect, test } from '../fixtures.ts';

// Analizar in Ayuda RE;write (issue #101, docs/design.md "Modes"): the scope is chosen and shown
// before sending; the prompt goes through the existing assistant panel with the page context of
// the open scene, against the real server and a stand-in engine process that calls no model.

test.use({ engine: true });

const SCENE = 'scenes/escena-01.md';
const DESKTOP = { width: 1280, height: 800 };
const PHONE = { width: 390, height: 844 };

const modeButton = (page: Page, name: string) => page.getByRole('group', { name: 'Modo' }).getByRole('button', { name, exact: true });
const words = (text: string) => (text.match(/[\p{L}\p{N}]+(?:['’-][\p{L}\p{N}]+)*/gu) ?? []).length;
const grouped = (n: number) => new Intl.NumberFormat('es', { useGrouping: 'always' }).format(n);

async function shoot(page: Page, name: string): Promise<void> {
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' });
    await page.screenshot({ path: test.info().outputPath(`${name}-${scheme}.png`) });
  }
  await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'no-preference' });
}

for (const [name, size] of [['desktop', DESKTOP], ['phone', PHONE]] as const) {
  test(`${name}: Analizar shows the scope, asks to connect ChatGPT first, then sends one prompt with the scene as context`, async ({ page, book }) => {
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    const prompts: Request[] = [];
    page.on('request', (request) => { if (request.method() === 'POST' && request.url().endsWith('/prompt')) prompts.push(request); });
    await page.setViewportSize(size);
    await page.goto(`${book.base}/review`);
    await modeButton(page, 'Ayuda RE;write').click();
    await expect(page.locator('.desk .cm-editor')).toBeVisible();
    const desk = page.locator('.desk');

    const analyse = desk.getByRole('button', { name: 'Analizar', exact: true });
    await expect(analyse).toHaveAttribute('aria-expanded', 'false');
    await analyse.click();
    const box = page.getByRole('region', { name: 'Analizar' });
    await expect(box.getByRole('group', { name: 'Qué analizar' }).getByRole('button', { name: 'Esta escena' })).toHaveAttribute('aria-pressed', 'true');
    const scope = box.locator('.analyse-scope');
    await expect(scope).toHaveText(`Se analizará: escena 01 (${grouped(words(book.bytes(SCENE).toString('utf8')))} palabras)`);

    // A selection becomes a scope of its own, counted as it is in the editor.
    const line = desk.locator('.cm-content .cm-line').nth(2);
    await line.click({ position: { x: 4, y: 4 } });
    await page.keyboard.press('Home');
    for (let i = 0; i < 'Elena llevaba'.length; i++) await page.keyboard.press('Shift+ArrowRight');
    await box.getByRole('button', { name: 'La selección' }).click();
    await expect(scope).toHaveText('Se analizará: la selección de escena 01 (2 palabras)');
    await box.getByRole('button', { name: 'El libro' }).click();
    await expect(scope).toHaveText('Se analizará: el libro «La puerta de Sal» (2 escenas)');
    await box.getByRole('button', { name: 'Esta escena' }).click();
    await shoot(page, `analizar-${name}-scope`);

    // Not connected: the panel opens on how to connect, with the prompt already written.
    await box.getByRole('button', { name: 'Enviar al asistente' }).click();
    const panel = page.getByRole('complementary', { name: 'Asistente' });
    await expect(panel).toBeVisible();
    await expect(panel.getByRole('button', { name: 'Conectar ChatGPT' })).toBeVisible();
    await expect(panel.getByText('Escena: escena-01')).toBeVisible();
    await expect(box.locator('.analyse-status')).toContainText('conecta tu propia cuenta de ChatGPT');
    expect(prompts).toHaveLength(0);

    await panel.getByRole('button', { name: 'Conectar ChatGPT' }).click();
    await expect(panel.getByText('ECHO-1234')).toBeVisible();
    await expect(panel.getByRole('textbox', { name: 'Mensaje para el asistente' })).toHaveValue(/^Analiza esta escena\./, { timeout: 10_000 });
    await expect(panel.getByText('ChatGPT: conectado')).toBeVisible({ timeout: 10_000 });
    if (name === 'phone') await panel.getByRole('button', { name: 'Cerrar el asistente' }).click();

    // Connected: one prompt, sent with the book and the scene as the page context.
    await box.getByRole('button', { name: 'Enviar al asistente' }).click();
    const answer = panel.locator('.answer');
    await expect(answer).toContainText(`book_id="sal" title="La puerta de Sal"; item=scene id="${SCENE}"`);
    await expect(box.locator('.analyse-status')).toHaveText('Enviado al asistente. La respuesta aparece en su panel.');
    expect(prompts).toHaveLength(1);
    const sent = JSON.parse(prompts[0].postData()!);
    expect(sent.context).toEqual({ book_id: 'sal', item: { kind: 'scene', id: SCENE } });
    expect(sent.text).toMatch(/^Analiza esta escena\. Fíjate en las motivaciones/);
    await shoot(page, `analizar-${name}-sent`);
    expect(errors).toEqual([]);
  });
}

test('Concentración has no Analizar: nothing is analysed while writing', async ({ page, book }) => {
  await page.setViewportSize(DESKTOP);
  await page.goto(`${book.base}/review`);
  await modeButton(page, 'Concentración').click();
  await expect(page.locator('.desk .cm-editor')).toBeVisible();
  await expect(page.locator('.desk').getByRole('button', { name: 'Analizar', exact: true })).toBeHidden();
});
