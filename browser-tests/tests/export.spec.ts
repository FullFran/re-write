import { readFileSync } from 'node:fs';
import { expect, test } from '../fixtures.ts';

// Exportar libro (docs/export.md): the desk's two buttons download the manuscript.

test('Exportar libro downloads the manuscript as Markdown and as Word', async ({ page, book }) => {
  await page.goto(`${book.base}/review`);
  await page.getByRole('group', { name: 'Modo' }).getByRole('button', { name: 'Concentración', exact: true }).click();
  const group = page.getByRole('group', { name: 'Exportar libro' });
  await expect(group).toBeVisible();

  const [markdown] = await Promise.all([
    page.waitForEvent('download'),
    group.getByRole('button', { name: 'Exportar Markdown' }).click(),
  ]);
  expect(markdown.suggestedFilename()).toMatch(/\.md$/);
  expect(readFileSync(await markdown.path()!, 'utf8')).toMatch(/^# /);

  const [word] = await Promise.all([
    page.waitForEvent('download'),
    group.getByRole('button', { name: 'Exportar Word' }).click(),
  ]);
  expect(word.suggestedFilename()).toMatch(/\.docx$/);
  // A zip starts with PK.
  expect(readFileSync(await word.path()!).subarray(0, 2).toString()).toBe('PK');
  await expect(page.locator('.desk-status')).toContainText('Libro exportado');
});
