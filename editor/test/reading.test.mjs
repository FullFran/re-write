import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readingTree } from '../src/reading.js';

test('reading shows headings, emphasis, quotes, lists and scene breaks without their markers', () => {
  const text = '# Capítulo uno\n\nElla *dudó* y luego **corrió**.\n\n> Nadie lo vio.\n> Nadie.\n\n- uno\n- dos\n\n***\n\n1. primero\n';
  assert.deepEqual(readingTree(text), [
    { tag: 'h1', children: ['Capítulo uno'] },
    { tag: 'p', children: ['Ella ', { tag: 'em', children: ['dudó'] }, ' y luego ', { tag: 'strong', children: ['corrió'] }, '.'] },
    { tag: 'blockquote', children: [{ tag: 'p', children: ['Nadie lo vio.\nNadie.'] }] },
    { tag: 'ul', children: [
      { tag: 'li', children: [{ tag: 'p', children: ['uno'] }] },
      { tag: 'li', children: [{ tag: 'p', children: ['dos'] }] },
    ] },
    { tag: 'hr', children: [] },
    { tag: 'ol', children: [{ tag: 'li', children: [{ tag: 'p', children: ['primero'] }] }] },
  ]);
});

test('HTML and links in a scene stay text: no element comes from the scene\'s own markup', () => {
  const text = '<img src=x onerror=alert(1)>\n\nUn [enlace](https://example.invalid "t") y <b>negrita</b>.\n';
  const tree = readingTree(text);
  assert.deepEqual(tree, [
    { tag: 'p', children: ['<img src=x onerror=alert(1)>'] },
    { tag: 'p', children: ['Un ', { tag: 'span', children: ['enlace'] }, ' y <b>negrita</b>.'] },
  ]);
  const tags = JSON.stringify(tree).match(/"tag":"[a-z0-9]+"/g);
  assert.deepEqual([...new Set(tags)].sort(), ['"tag":"p"', '"tag":"span"']);
});

test('an empty scene reads as nothing', () => {
  assert.deepEqual(readingTree(''), []);
});

test('reading shows a wikilink as the text a reader sees, and leaves embeds as written', () => {
  assert.deepEqual(readingTree('Vio a [[Elena|la capitana]] en [[Sal#Puerto]], ![[Mapa]] y [[Nadie]].\n'), [
    { tag: 'p', children: ['Vio a ', { tag: 'span', children: ['la capitana'] }, ' en ', { tag: 'span', children: ['Sal'] }, ', ![[Mapa]] y ', { tag: 'span', children: ['Nadie'] }, '.'] },
  ]);
});
