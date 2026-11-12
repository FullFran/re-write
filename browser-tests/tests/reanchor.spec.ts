import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Page } from '@playwright/test';
import { ANNOTATIONS, expect, test, type Book } from '../fixtures.ts';

// Re-anchoring stale evidence after a reopen (#109), through the real page and the real server.

const SCENE = 'scenes/escena-01.md';
const QUOTE = 'Elena llevaba once años custodiando el puente de Sal';
const DESKTOP = { width: 1280, height: 800 };
const PHONE = { width: 390, height: 844 };

/** The narrated fact, accepted, then its scene changed underneath it. */
function acceptedThenEdited(book: Book, change: (text: string) => string): string {
  book.cli('extract', '--from', ANNOTATIONS);
  const id = book.cli('claims').claims.find((c: any) => c.anchor.quote === QUOTE).claim_id;
  book.cli('review-claim', id, 'accept');
  writeFileSync(join(book.dir, SCENE), change(book.bytes(SCENE).toString('utf8')));
  book.git('commit', '-qam', 'edit');
  return id;
}

const claimIn = (page: Page, section: string, book: Book, id: string) =>
  page.locator(`#sec-${section} article[id$="claim-${book.book}-${id}"]`);

/** Reopens the claim from "Afirmaciones fuera del Canon", where stale evidence keeps it. */
async function reopen(page: Page, book: Book, id: string): Promise<void> {
  await page.goto(`${book.base}/review`);
  const outside = claimIn(page, 'fuera-del-canon', book, id);
  await expect(outside).toBeAttached();
  // On a phone the settled sections start folded.
  if (!(await outside.isVisible())) await page.locator('#sec-fuera-del-canon button.fold').click();
  await outside.getByRole('button', { name: 'Deshacer decisión editorial' }).click();
}

for (const [name, size] of [['desktop', DESKTOP], ['phone', PHONE]] as const) {
  test(`${name}: a reopened claim whose quote moved shows the suggestion; accepting it puts the claim back in Canon`, async ({ page, book }, info) => {
    await page.setViewportSize(size);
    const id = acceptedThenEdited(book, (text) => text.replace(`${QUOTE}, y conocía`, `Nadie sabía nada.\n\nAquella noche, ${QUOTE}, y conocía`));
    await reopen(page, book, id);

    const card = claimIn(page, 'afirmaciones', book, id);
    await expect(card).toContainText('Cita anterior:');
    await expect(card.locator('.reanchor blockquote')).toHaveText([QUOTE, QUOTE]);
    await expect(card.getByRole('button', { name: 'Aceptar', exact: true })).toHaveCount(0);
    await card.scrollIntoViewIfNeeded();
    await card.screenshot({ path: info.outputPath(`reanchor-suggestion-${name}.png`) });

    const before = Number(book.git('rev-list', '--count', 'HEAD'));
    await card.getByRole('button', { name: 'Aceptar pasaje sugerido' }).click();
    await expect(card.locator('.decision-log li').last()).toHaveText(/^Nuevo anclaje aceptado por /);
    await expect(card.locator('.reanchor')).toHaveCount(0);
    expect(Number(book.git('rev-list', '--count', 'HEAD'))).toBe(before + 1);
    const stored = book.cli('claims').claims.find((c: any) => c.claim_id === id);
    expect(stored.evidence_status).toBe('valid');
    expect(stored.history.map((e: any) => e.action ?? e.to)).toEqual(['accepted', 'reopen', 'reanchor']);

    await card.getByRole('button', { name: 'Aceptar', exact: true }).click();
    await expect(claimIn(page, 'canon', book, id)).toHaveCount(1);
    expect(book.cli('canon').claims.some((c: any) => c.claim_id === id)).toBe(true);
  });
}

test('a reopened claim whose quote was removed says that no passage was found', async ({ page, book }) => {
  await page.setViewportSize(DESKTOP);
  const id = acceptedThenEdited(book, (text) => text.replace(`${QUOTE}, y conocía cada grieta de sus piedras.\n\n`, ''));
  await reopen(page, book, id);
  const card = claimIn(page, 'afirmaciones', book, id);
  await expect(card).toContainText('No se encontró un pasaje');
  await expect(card.getByRole('button', { name: 'Aceptar pasaje sugerido' })).toHaveCount(0);
  await expect(card.getByRole('button', { name: 'Rechazar' })).toBeVisible();
});
