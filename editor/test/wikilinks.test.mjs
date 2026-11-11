import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EditorSelection, EditorState } from '@codemirror/state';
import { ensureSyntaxTree } from '@codemirror/language';
import { markdown } from '../src/markdown.js';
import { completeWikilink, foldName, linkAt, noteIndex, wikilinkRanges, wikilinksIn } from '../src/wikilinks.js';

const NOTES = [
  { name: 'Elena', type: 'personaje', aliases: ['la capitana'] },
  { name: 'Puerto de Sal', type: 'lugar', aliases: [] },
  { name: 'Árbol', type: 'objeto', aliases: [] },
];

function stateOf(text, cursor) {
  const state = EditorState.create({ doc: text, extensions: [markdown()], selection: EditorSelection.cursor(cursor) });
  ensureSyntaxTree(state, state.doc.length, 5000);
  return state;
}

function ranges(text, cursor, notes = NOTES) {
  const state = stateOf(text, cursor);
  return wikilinkRanges(state, [{ from: 0, to: state.doc.length }], noteIndex(notes))
    .map((r) => [r.kind, text.slice(r.from, r.to), r.cls ?? null, r.target ?? null]);
}

test('folding matches the server: accents, case and spaces are ignored, ß is kept', () => {
  assert.equal(foldName('  ÁRBOL   de\tSal '), 'arbol de sal');
  assert.equal(foldName('Straße'), 'straße');
});

test('a note name wins over an alias, two notes matching the same way are ambiguous, and nothing matching is unresolved', () => {
  const index = noteIndex([
    { name: 'Elena', aliases: ['Sal'] },
    { name: 'Sal', aliases: [] },
    { name: 'Marta', aliases: ['la capitana'] },
    { name: 'Lucía', aliases: ['la capitana'] },
  ]);
  assert.deepEqual(index.resolve('sal'), { status: 'resolved', note: 'Sal' });
  assert.deepEqual(index.resolve('LA CAPITANA'), { status: 'ambiguous', candidates: ['Lucía', 'Marta'] });
  assert.deepEqual(index.resolve('lucia'), { status: 'resolved', note: 'Lucía' });
  assert.deepEqual(index.resolve('Nadie'), { status: 'unresolved' });
});

test('links are read like the server reads them: shown text, section, embeds and block references skipped', () => {
  const text = 'A [[Elena|la capitana]], [[Puerto de Sal#Muelle]], ![[Elena]], [[Elena#^b1]] y [[]].';
  assert.deepEqual(wikilinksIn(text, 0).map((l) => [text.slice(l.from, l.to), l.target, l.shownFrom === undefined ? null : text.slice(l.shownFrom, l.shownTo)]), [
    ['[[Elena|la capitana]]', 'Elena', 'la capitana'],
    ['[[Puerto de Sal#Muelle]]', 'Puerto de Sal', 'Puerto de Sal'],
  ]);
});

test('live preview: away from the cursor a link shows only its text, styled by whether it resolves', () => {
  const text = 'Vio a [[Elena|la capitana]] en [[Puerto de Sal#Muelle]] con [[Nadie]].\n\nFin.';
  assert.deepEqual(ranges(text, text.length), [
    ['hide', '[[Elena|', null, null],
    ['mark', 'la capitana', 'cm-wikilink', 'Elena'],
    ['hide', ']]', null, null],
    ['hide', '[[', null, null],
    ['mark', 'Puerto de Sal', 'cm-wikilink', 'Puerto de Sal'],
    ['hide', '#Muelle]]', null, null],
    ['hide', '[[', null, null],
    ['mark', 'Nadie', 'cm-wikilink cm-wikilink-unresolved', 'Nadie'],
    ['hide', ']]', null, null],
  ]);
});

test('live preview: on the line with the cursor the brackets stay visible and the link is still styled', () => {
  const text = 'Vio a [[Elena|la capitana]].\n\nOtra [[Elena]].';
  const got = ranges(text, 3);
  assert.deepEqual(got.filter(([, raw]) => raw.includes('capitana')), [['mark', '[[Elena|la capitana]]', 'cm-wikilink', 'Elena']]);
  assert.ok(got.some(([kind, raw]) => kind === 'hide' && raw === '[['), 'another line still hides its brackets');
});

test('live preview: links inside code spans and fenced code are left alone', () => {
  const text = 'Uno `[[Elena]]` dos.\n\n```\n[[Elena]]\n```\n\nFin.';
  assert.deepEqual(ranges(text, text.length), []);
});

test('the link under the cursor, for Enter: inside the brackets only', () => {
  const text = 'Vio a [[Elena|la capitana]] ya.';
  const at = (pos) => linkAt(stateOf(text, pos), pos)?.target ?? null;
  assert.equal(at(text.indexOf('capitana')), 'Elena');
  assert.equal(at(text.indexOf('[[') + 2), 'Elena');
  assert.equal(at(text.indexOf('[[')), null, 'before the brackets is outside');
  assert.equal(at(text.indexOf(']]') + 2), null, 'after the brackets is outside');
});

test('[[ completes note names and aliases, ignoring case and accents, and closes the link', () => {
  const run = (text) => completeWikilink(stateOf(text, text.length), text.length, NOTES);
  const byName = run('Vio a [[ARBO');
  assert.equal(byName.from, 'Vio a [['.length);
  assert.deepEqual(byName.options.map((o) => [o.label, o.insert]), [['Árbol', 'Árbol]]']]);
  const byAlias = run('Vio a [[capi');
  assert.deepEqual(byAlias.options.map((o) => [o.label, o.insert, o.detail]), [['la capitana', 'Elena|la capitana]]', 'Elena']]);
  // Prefix matches come first, then the rest, by name.
  assert.deepEqual(run('[[e').options.map((o) => o.label), ['Elena', 'Puerto de Sal']);
  assert.deepEqual(run('[[').options.map((o) => o.label), ['Árbol', 'Elena', 'la capitana', 'Puerto de Sal']);
  assert.equal(run('Vio a ![[Ele'), null, 'an embed is not a link');
  assert.equal(run('Vio a [Ele'), null);
  assert.equal(run('Vio [[Elena|la ca'), null, 'the shown text is free');
  const code = 'Uno `[[Ele` dos';
  assert.equal(completeWikilink(stateOf(code, code.indexOf('Ele') + 3), code.indexOf('Ele') + 3, NOTES), null, 'not inside a code span');
});

test('completion does not add closing brackets that are already there', () => {
  const text = 'Vio a [[Ele]] ya.';
  const pos = text.indexOf(']]');
  const got = completeWikilink(stateOf(text, pos), pos, NOTES);
  assert.equal(got.to, pos);
  assert.deepEqual(got.options.map((o) => o.insert), ['Elena']);
});
