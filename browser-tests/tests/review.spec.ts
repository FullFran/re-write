import type { Page } from '@playwright/test';
import { ANNOTATIONS, expect, test, type Book } from '../fixtures.ts';

// The checklist blockers of docs/review-checklist.md (§3, §5 and §6), driven through the
// real page against the real server: what the person sees, and the bytes on disk.

const SCENE = 'scenes/escena-01.md';
const SENTENCE = 'Fuera empezaba a llover';

function propose(book: Book, replace: string, rationale: string, find = SENTENCE, file = SCENE): string {
  return book.cli('propose', '--file', file, '--find', find, '--replace', replace, '--rationale', rationale).proposal.proposal_id;
}

async function open(page: Page, book: Book): Promise<void> {
  await page.goto(`${book.base}/review`);
  await expect(page.getByRole('navigation', { name: 'Secciones' })).toBeVisible();
}

const proposalIn = (page: Page, section: string, book: Book, id: string) =>
  page.locator(`#sec-${section} article[id$="proposal-${book.book}-${id}"]`);
const claimIn = (page: Page, section: string, book: Book, id: string) =>
  page.locator(`#sec-${section} article[id$="claim-${book.book}-${id}"]`);

test('rejecting a proposal shows it rejected and leaves the manuscript bytes unchanged', async ({ page, book }) => {
  const id = propose(book, 'Fuera arreciaba la tormenta', 'Una imagen más intensa');
  const before = book.bytes(SCENE);
  const head = book.git('rev-parse', 'HEAD');
  await open(page, book);

  const card = proposalIn(page, 'cambios', book, id);
  await expect(card.locator('.state-badge')).toHaveText('Pendiente');
  await expect(card).toContainText('Una imagen más intensa');
  await card.getByRole('button', { name: 'Rechazar' }).click();

  // The card stays where the person acted, with its new state, no decision and a way back.
  await expect(card.locator('.state-badge')).toHaveText('Rechazada');
  await expect(card.locator('.decision')).toHaveCount(0);
  await expect(card.getByRole('button')).toHaveText(['Deshacer']);
  expect(book.bytes(SCENE).equals(before)).toBe(true);
  expect(book.git('diff', '--name-only', head, 'HEAD', '--', 'scenes')).toBe('');
  expect(book.cli('show', id).proposal.status).toBe('rejected');

  // After a reload the decision is in the history, not among the pending changes.
  await page.reload();
  await expect(proposalIn(page, 'historial', book, id).locator('.state-badge')).toHaveText('Rechazada');
  await expect(proposalIn(page, 'cambios', book, id)).toHaveCount(0);
  await expect(page.locator('#sec-cambios')).toContainText('Ningún cambio pendiente.');
  expect(book.bytes(SCENE).equals(before)).toBe(true);
});

test('a stale proposal warns, offers no accept, and can still be rejected without touching the text', async ({ page, book }) => {
  const first = propose(book, 'Fuera arreciaba la tormenta', 'Primera opción');
  const second = propose(book, 'Fuera el cielo seguía despejado', 'Segunda opción');
  const original = book.bytes(SCENE);
  const start = book.git('rev-parse', 'HEAD');
  await open(page, book);

  const winner = proposalIn(page, 'cambios', book, first);
  const stale = proposalIn(page, 'cambios', book, second);
  await expect(stale.getByRole('button', { name: 'Aceptar cambio' })).toBeVisible();
  await winner.getByRole('button', { name: 'Aceptar cambio' }).click();
  await expect(winner.locator('.state-badge')).toHaveText('Aceptada');
  await expect(winner.getByRole('button')).toHaveText(['Deshacer']);

  // Accepting the first changed the passage the second was made against, in one new
  // commit that keeps the previous text in history.
  const accepted = book.bytes(SCENE);
  expect(accepted.toString('utf8')).toContain('Fuera arreciaba la tormenta');
  const head = book.git('rev-parse', 'HEAD');
  expect(book.git('rev-list', '--count', `${start}..HEAD`)).toBe('1');
  expect(book.git('show', `${start}:${SCENE}`)).toBe(original.toString('utf8').trim());
  await expect(stale.locator('.state-badge')).toHaveText('No aplicable: la escena ha cambiado');
  await expect(stale).toContainText('La escena ha cambiado desde esta propuesta: ya no se puede aplicar.');
  await expect(stale.getByRole('button', { name: 'Aceptar cambio' })).toHaveCount(0);

  await stale.getByRole('button', { name: 'Rechazar' }).click();
  await expect(stale.locator('.state-badge')).toHaveText('Rechazada');
  await expect(stale.getByRole('button')).toHaveText(['Deshacer']);
  expect(book.bytes(SCENE).equals(accepted)).toBe(true);
  expect(book.git('diff', '--name-only', head, 'HEAD', '--', 'scenes')).toBe('');
  expect(book.cli('show', second).proposal.status).toBe('rejected');

  await page.reload();
  await expect(proposalIn(page, 'historial', book, second).locator('.state-badge')).toHaveText('Rechazada');
  const acceptedCard = proposalIn(page, 'historial', book, first);
  await expect(acceptedCard.locator('.state-badge')).toHaveText('Aceptada');
  await expect(acceptedCard).toContainText(`versión ${book.cli('show', first).proposal.result_commit.slice(0, 10)}`);
});

test('unreviewed claims stay out of Canon, also after accepting manuscript text', async ({ page, book }) => {
  book.cli('extract', '--from', ANNOTATIONS);
  const created = book.cli('claims').claims;
  expect(created.length).toBe(5);
  const fact = created.find((c: any) => c.statement.startsWith('Elena has guarded the Salt bridge'));
  const unreviewed = created.filter((c: any) => c.claim_id !== fact.claim_id);
  expect(unreviewed.length).toBeGreaterThan(0);
  // The proposal edits a sentence no claim quotes, so every claim keeps valid evidence.
  const proposal = propose(book, 'Fuera arreciaba la tormenta', 'Una imagen más intensa');
  await open(page, book);

  const canon = page.locator('#sec-canon');
  await expect(canon).toContainText('El canon está vacío.');
  for (const claim of created) {
    await expect(claimIn(page, 'afirmaciones', book, claim.claim_id).locator('.state-badge')).toHaveText('Pendiente');
  }

  await proposalIn(page, 'cambios', book, proposal).getByRole('button', { name: 'Aceptar cambio' }).click();
  await expect(proposalIn(page, 'cambios', book, proposal).locator('.state-badge')).toHaveText('Aceptada');
  await expect(canon).toContainText('El canon está vacío.');
  await expect(canon.locator('article')).toHaveCount(0);
  expect(book.cli('canon').canon).toEqual([]);

  // A person accepts one narrated fact: only that one enters Canon.
  const manuscript = book.bytes(SCENE);
  const head = book.git('rev-parse', 'HEAD');
  const card = claimIn(page, 'afirmaciones', book, fact.claim_id);
  await card.getByRole('button', { name: 'Aceptar' }).click();
  await expect(card.locator('.state-badge')).toHaveText('Aceptada');
  await expect(canon.locator('article')).toHaveCount(1);
  await expect(claimIn(page, 'canon', book, fact.claim_id)).toContainText(fact.statement);
  await expect(canon).toContainText('Solo hechos narrados aceptados por una persona y con evidencia válida. Aceptar un cambio de texto no aprueba sus afirmaciones.');
  for (const claim of unreviewed) {
    await expect(claimIn(page, 'canon', book, claim.claim_id)).toHaveCount(0);
    await expect(claimIn(page, 'afirmaciones', book, claim.claim_id).locator('.state-badge')).toHaveText('Pendiente');
  }
  expect(book.cli('canon').canon.map((c: any) => c.claim_id)).toEqual([fact.claim_id]);
  // Deciding claims never writes the manuscript.
  expect(book.bytes(SCENE).equals(manuscript)).toBe(true);
  expect(book.git('diff', '--name-only', head, 'HEAD', '--', 'scenes')).toBe('');
});

test.describe('on a phone', () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

  test('the first pending proposal is on the first screen below the navigation, and nothing scrolls sideways', async ({ page, book }) => {
    book.cli('extract', '--from', ANNOTATIONS);
    const id = propose(book, 'Fuera arreciaba la tormenta', 'Véase https://example.invalid/una-referencia-editorial-muy-larga-sin-espacios-que-no-debe-desbordar-la-pantalla');
    await open(page, book);

    const card = proposalIn(page, 'cambios', book, id);
    await expect(card.locator('.state-badge')).toHaveText('Pendiente');
    expect(await page.evaluate(() => window.scrollY)).toBe(0);
    const nav = await page.getByRole('navigation', { name: 'Secciones' }).boundingBox();
    const badge = await card.locator('.state-badge').boundingBox();
    expect(nav && badge).toBeTruthy();
    expect(badge!.y).toBeGreaterThanOrEqual(nav!.y + nav!.height);
    expect(badge!.y + badge!.height).toBeLessThanOrEqual(844);
    await expect(card.getByRole('button', { name: 'Aceptar cambio' })).toBeInViewport();
    for (const form of ['#sec-importar', '#sec-notion']) {
      expect((await page.locator(form).boundingBox())!.y).toBeGreaterThan(badge!.y);
    }
    const { scrollWidth, clientWidth } = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
    }));
    expect(scrollWidth).toBeLessThanOrEqual(clientWidth);
  });
});
