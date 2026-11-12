import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { cli, tempDir } from './helpers.ts';

/** A tiny book with the age and place problems planted in two scenes. */
export function plantedBook(): string {
  const dir = join(tempDir(), 'book');
  const scenes = tempDir();
  writeFileSync(join(scenes, 'uno.md'), '# Uno\n\nElena llevaba once años custodiando el puente de Sal.\n\nLa Casa del Peso estaba en la orilla de Sal, frente a la fuente.\n');
  writeFileSync(join(scenes, 'dos.md'), '# Dos\n\nElena, que llevaba nueve años en el puente, lo esperaba.\n\nHabía pasado por la Casa del Peso, al otro lado del río, en Ribera.\n');
  cli('init', dir);
  cli('import', dir, join(scenes, 'uno.md'), join(scenes, 'dos.md'));
  return dir;
}

export const planted = [
  { statement: 'Elena has guarded the bridge for eleven years.', subject: 'Elena', source_file: 'scenes/uno.md',
    quote: 'Elena llevaba once años custodiando el puente de Sal', scope: 'book', epistemic_kind: 'narrated_fact', story_time: 1,
    attribute: { name: 'años_en', value: 'once', unit: 'años', about: 'puente de Sal' } },
  { statement: 'Elena has been on the bridge for nine years.', subject: 'Elena', source_file: 'scenes/dos.md',
    quote: 'que llevaba nueve años en el puente', scope: 'book', epistemic_kind: 'narrated_fact', story_time: 20,
    attribute: { name: 'años_en', value: '9', unit: 'años', about: 'puente de Sal' } },
  { statement: 'The Casa del Peso stands on the Sal bank.', subject: 'Casa del Peso', source_file: 'scenes/uno.md',
    quote: 'estaba en la orilla de Sal', scope: 'book', epistemic_kind: 'narrated_fact', story_time: 6,
    attribute: { name: 'lugar', value: 'orilla de Sal' } },
  { statement: 'The Casa del Peso stands in Ribera.', subject: 'Casa del Peso', source_file: 'scenes/dos.md',
    quote: 'al otro lado del río, en Ribera', scope: 'book', epistemic_kind: 'narrated_fact', story_time: 17,
    attribute: { name: 'lugar', value: 'Ribera' } },
];
