import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkNoteName, NOTE_TYPES, parseFrontmatter } from '../src/domain/note.ts';

test('a note name is refused when it cannot be a safe, single file name', () => {
  for (const name of ['Elena', 'Puente de Sal', 'Ángel Peña', 'La carta (1)']) assert.equal(checkNoteName(name), null, name);
  const refused: [string, RegExp][] = [
    ['', /empty/], ['  ', /empty/], [' Elena', /spaces/], ['Elena ', /spaces/], ['.oculta', /dot/],
    ['a/b', /\//], ['a\\b', /\\/], ['a:b', /:/], ['a\u0000b', /control/], ['a\tb', /control/], ['a\u007fb', /control/],
    ['a'.repeat(253), /255 bytes/], ['[[x]]', /\[/], ['a|b', /\|/], ['a#b', /#/], ['a^b', /\^/],
  ];
  for (const [name, reason] of refused) assert.match(checkNoteName(name) ?? 'accepted', reason, JSON.stringify(name));
  assert.equal(checkNoteName('a'.repeat(252)), null, '252 bytes plus ".md" is exactly 255');
});

test('frontmatter: type and aliases in flow and block lists, other keys and the body untouched', () => {
  const text = '---\ntype: personaje\naliases: [la capitana, "Elena, la de Sal", \'Ele\']\ncolor: azul\nlista:\n  - uno\n---\n# Elena\n\nTexto.\n';
  assert.deepEqual(parseFrontmatter(text), {
    type: 'personaje', aliases: ['la capitana', 'Elena, la de Sal', 'Ele'], problems: [], body_start: text.indexOf('# Elena'),
  });
  const block = '---\r\naliases:\r\n  - Capi\r\n  - "La Jefa"\r\ntype: "lugar"\r\n---\r\n';
  assert.deepEqual(parseFrontmatter(block), { type: 'lugar', aliases: ['Capi', 'La Jefa'], problems: [], body_start: block.length });
  assert.deepEqual(NOTE_TYPES, ['personaje', 'lugar', 'objeto', 'trama', 'otra']);
});

test('no frontmatter, or one that never closes, leaves the whole text as body', () => {
  assert.deepEqual(parseFrontmatter('# Solo texto\n---\ntype: lugar\n---\n'), { type: null, aliases: [], problems: [], body_start: 0 });
  assert.deepEqual(parseFrontmatter('---\ntype: lugar\n'), { type: null, aliases: [], problems: ['the frontmatter opened by "---" is never closed'], body_start: 0 });
});

test('a malformed supported key is reported, never guessed', () => {
  const problems = (fm: string) => parseFrontmatter(`---\n${fm}\n---\n`).problems;
  assert.deepEqual(problems('type: villano'), ['type must be one of personaje, lugar, objeto, trama, otra; found "villano"']);
  assert.deepEqual(problems('type: lugar\ntype: objeto'), ['type appears more than once']);
  assert.deepEqual(problems('aliases: [a, b'), ['aliases must be a list like [a, b] or lines starting with "- "']);
  assert.deepEqual(problems('aliases: Capi'), ['aliases must be a list like [a, b] or lines starting with "- "']);
  assert.deepEqual(problems('aliases: [a, "", b]'), ['aliases cannot hold an empty name']);
  assert.deepEqual(parseFrontmatter('---\ntype: villano\naliases: [a]\n---\n').aliases, ['a'], 'one bad key does not hide the others');
});
