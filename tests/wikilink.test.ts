import assert from 'node:assert/strict';
import { test } from 'node:test';
import { displayText, foldName, parseWikilinks } from '../src/domain/wikilink.ts';

test('parses the three link forms with their target, section, shown text and position', () => {
  const text = 'Primera línea.\nVio a [[Elena]] y a [[Elena|la capitana]] junto a [[Puente de Sal#Historia]].';
  const links = parseWikilinks(text);
  assert.deepEqual(links.map(({ target, section, label, shown, line, column }) => ({ target, section, label, shown, line, column })), [
    { target: 'Elena', section: null, label: null, shown: 'Elena', line: 2, column: 7 },
    { target: 'Elena', section: null, label: 'la capitana', shown: 'la capitana', line: 2, column: 21 },
    { target: 'Puente de Sal', section: 'Historia', label: null, shown: 'Puente de Sal', line: 2, column: 51 },
  ]);
  for (const link of links) assert.equal(text.slice(link.start, link.end), link.raw);
  assert.equal(links[1].raw, '[[Elena|la capitana]]');
});

test('ignores links inside code spans and fenced code blocks', () => {
  const text = 'Uno `[[Falso]]` y ``doble `[[Falso]]` span`` y [[Real]].\n```\n[[Falso]]\n```\n~~~md\n[[Falso]]\n~~~\nFin [[Otro]].';
  assert.deepEqual(parseWikilinks(text).map((link) => link.target), ['Real', 'Otro']);
});

test('embeds, block references, empty and broken links are skipped without breaking later links', () => {
  const text = '![[Mapa]] [[Elena#^bloque]] [[]] [[ |x]] [[sin cierre y [[Bien]] [[a\nb]] ]] [[Tras]]';
  assert.deepEqual(parseWikilinks(text).map((link) => link.target), ['Bien', 'Tras']);
});

test('an unclosed fence hides the rest of the text, as a Markdown renderer would', () => {
  assert.deepEqual(parseWikilinks('[[Antes]]\n```\n[[Dentro]]'), [parseWikilinks('[[Antes]]')[0]]);
});

test('export text: each link becomes its shown text and everything else is unchanged', () => {
  assert.equal(
    displayText('Vio a [[Elena|la capitana]] y a [[Elena]] en [[Sal#Puerto]]. `[[código]]` ![[Mapa]]\r\n'),
    'Vio a la capitana y a Elena en Sal. `[[código]]` ![[Mapa]]\r\n',
  );
  assert.equal(displayText('sin enlaces'), 'sin enlaces');
});

test('names fold to one key: case, accents and spacing do not matter', () => {
  assert.equal(foldName('  Ángel   DE la  Peña '), 'angel de la pena');
  assert.equal(foldName('ÉLENA'), foldName('elena'));
  assert.equal(foldName('Straße'), 'straße', 'only case folding and accent removal, no transliteration');
});
