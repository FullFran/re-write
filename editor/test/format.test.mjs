import assert from 'node:assert/strict';
import { test } from 'node:test';
import { history, undo } from '@codemirror/commands';
import { EditorSelection, EditorState } from '@codemirror/state';
import { applyFormat, formatState, toggleEmphasis, toggleLinePrefix, toggleSceneBreak, toggleWikilink } from '../src/format.js';

// The toolbar's rules on raw Markdown. In these strings ‸ is the cursor and «…» the selection
// (the « is the anchor); several of them make several ranges.
function stateOf(marked, extensions = []) {
  const ranges = [];
  let text = '';
  let anchor = null;
  for (const ch of marked) {
    if (ch === '‸') ranges.push(EditorSelection.cursor(text.length));
    else if (ch === '«') anchor = text.length;
    else if (ch === '»') { ranges.push(EditorSelection.range(anchor, text.length)); anchor = null; }
    else text += ch;
  }
  return EditorState.create({ doc: text, selection: EditorSelection.create(ranges), extensions: [EditorState.allowMultipleSelections.of(true), ...extensions] });
}
function show(state) {
  let text = state.doc.toString();
  const marks = [];
  for (const r of state.selection.ranges) {
    if (r.empty) marks.push([r.head, '‸']);
    else marks.push([r.from, '«'], [r.to, '»']);
  }
  marks.sort((a, b) => b[0] - a[0]);
  for (const [at, ch] of marks) text = text.slice(0, at) + ch + text.slice(at);
  return text;
}
const run = (marked, rule) => {
  const state = stateOf(marked);
  const spec = rule(state);
  return spec ? show(state.update(spec).state) : null;
};
const bold = (s) => toggleEmphasis(s, 2);
const italic = (s) => toggleEmphasis(s, 1);

test('Negrita wraps a selection in ** and removes them when the selection already has them, inside or around it', () => {
  assert.equal(run('Elena «llevaba» once años', bold), 'Elena **«llevaba»** once años');
  assert.equal(run('Elena **«llevaba»** once años', bold), 'Elena «llevaba» once años');
  assert.equal(run('Elena «**llevaba**» once años', bold), 'Elena «llevaba» once años');
});

test('Cursiva toggles one *, and tells italic from bold in a run of stars', () => {
  assert.equal(run('Elena «llevaba» once', italic), 'Elena *«llevaba»* once');
  assert.equal(run('Elena *«llevaba»* once', italic), 'Elena «llevaba» once');
  // Bold is not italic: Cursiva adds its own star around it.
  assert.equal(run('Elena **«llevaba»** once', italic), 'Elena ***«llevaba»*** once');
  // Both: each action removes only its own stars.
  assert.equal(run('Elena ***«llevaba»*** once', italic), 'Elena **«llevaba»** once');
  assert.equal(run('Elena ***«llevaba»*** once', bold), 'Elena *«llevaba»* once');
});

test('a selection with outer spaces is wrapped without them, so the Markdown stays emphasis', () => {
  assert.equal(run('Elena« llevaba »once', bold), 'Elena« **llevaba** »once');
});

test('a selection over several lines is emphasised line by line, never across a paragraph break', () => {
  assert.equal(run('«uno\n\ndos»', bold), '«**uno**\n\n**dos**»');
  assert.equal(run('«**uno**\n\n**dos**»', bold), '«uno\n\ndos»');
  // Mixed: the missing one is added, the other is left as it is.
  assert.equal(run('«**uno**\n\ndos»', bold), '«**uno**\n\n**dos**»');
});

test('at the cursor: inside a word it acts on the word; elsewhere an empty pair, removed by a second press', () => {
  assert.equal(run('Elena lle‸vaba once', bold), 'Elena **lle‸vaba** once');
  assert.equal(run('Elena **lle‸vaba** once', bold), 'Elena lle‸vaba once');
  assert.equal(run('Elena ‸', bold), 'Elena **‸**');
  assert.equal(run('Elena **‸**', bold), 'Elena ‸');
  assert.equal(run('Elena ‸', italic), 'Elena *‸*');
  assert.equal(run('Elena *‸*', italic), 'Elena ‸');
});

test('every range of a multiple selection is handled in one change', () => {
  assert.equal(run('«uno» y «dos»', italic), '*«uno»* y *«dos»*');
});

test('Título 1, 2 and 3 set the heading of the touched lines, replace another level, and remove their own', () => {
  assert.equal(run('La pu‸erta', (s) => toggleLinePrefix(s, 'h1')), '# La pu‸erta');
  assert.equal(run('# La pu‸erta', (s) => toggleLinePrefix(s, 'h1')), 'La pu‸erta');
  assert.equal(run('# La pu‸erta', (s) => toggleLinePrefix(s, 'h2')), '## La pu‸erta');
  assert.equal(run('### La pu‸erta', (s) => toggleLinePrefix(s, 'h3')), 'La pu‸erta');
  // A cursor at the start of an empty line ends after the new prefix, ready to type.
  assert.equal(run('‸', (s) => toggleLinePrefix(s, 'h2')), '## ‸');
});

test('Cita quotes every non-blank touched line, and removes the quote when all have it', () => {
  assert.equal(run('«uno\n\ndos»', (s) => toggleLinePrefix(s, 'quote')), '«> uno\n\n> dos»');
  assert.equal(run('«> uno\n\n> dos»', (s) => toggleLinePrefix(s, 'quote')), '«uno\n\ndos»');
  assert.equal(run('«> uno\ndos»', (s) => toggleLinePrefix(s, 'quote')), '«> uno\n> dos»');
});

test('Lista and Lista numerada toggle, convert each other, and number from 1', () => {
  assert.equal(run('«uno\ndos»', (s) => toggleLinePrefix(s, 'bullet')), '«- uno\n- dos»');
  assert.equal(run('«- uno\n- dos»', (s) => toggleLinePrefix(s, 'bullet')), '«uno\ndos»');
  assert.equal(run('«uno\ndos\ntres»', (s) => toggleLinePrefix(s, 'ordered')), '«1. uno\n2. dos\n3. tres»');
  assert.equal(run('«- uno\n- dos»', (s) => toggleLinePrefix(s, 'ordered')), '«1. uno\n2. dos»');
  assert.equal(run('«1. uno\n2. dos»', (s) => toggleLinePrefix(s, 'bullet')), '«- uno\n- dos»');
  assert.equal(run('«1. uno\n2. dos»', (s) => toggleLinePrefix(s, 'ordered')), '«uno\ndos»');
  // A selection ending at the start of a line does not touch that line.
  assert.equal(run('«uno\n»dos', (s) => toggleLinePrefix(s, 'bullet')), '«- uno\n»dos');
});

test('Separador de escena puts *** on its own line between blank lines, and removes it from a break line', () => {
  assert.equal(run('Fin de la escena.‸\nOtra escena.', toggleSceneBreak), 'Fin de la escena.\n\n***\n\n‸Otra escena.');
  assert.equal(run('Fin.‸', toggleSceneBreak), 'Fin.\n\n***\n\n‸');
  assert.equal(run('Fin.\n‸\nOtra.', toggleSceneBreak), 'Fin.\n\n***\n\n‸Otra.');
  // At the end of a text that ends with a line break: the cursor gets a fresh line below.
  assert.equal(run('Fin.\n‸', toggleSceneBreak), 'Fin.\n\n***\n\n‸');
  assert.equal(run('Fin.\n\n**‸*\n\nOtra.', toggleSceneBreak), 'Fin.\n‸\n\nOtra.');
});

test('Enlace a nota opens [[ at the cursor, wraps a selection, and unwraps a link', () => {
  assert.equal(run('Habló con ‸', toggleWikilink), 'Habló con [[‸');
  assert.equal(run('Habló con «Elena»', toggleWikilink), 'Habló con [[«Elena»]]');
  assert.equal(run('Habló con [[«Elena»]]', toggleWikilink), 'Habló con «Elena»');
  assert.equal(run('Habló con «[[Elena]]»', toggleWikilink), 'Habló con «Elena»');
});

test('the buttons show what is on where the cursor is', () => {
  const on = formatState(stateOf('## Una **pal‸abra**'));
  assert.equal(on.bold, true);
  assert.equal(on.italic, false);
  assert.equal(on.h2, true);
  assert.equal(on.h1, false);
  assert.equal(formatState(stateOf('- uno‸')).bullet, true);
  assert.equal(formatState(stateOf('***\n‸')).bullet, false);
});

test('an action is one undo step and edits the document like typing: nothing else of the text changes', () => {
  const original = 'Primera línea\n\n«Elena» llevaba   dos espacios\n';
  let state = stateOf(original, [history()]);
  const view = { get state() { return state; }, dispatch(spec) { state = state.update(spec).state; }, focus() {} };
  assert.equal(applyFormat(view, 'bold'), true);
  assert.equal(applyFormat(view, 'quote'), true);
  assert.equal(state.doc.toString(), 'Primera línea\n\n> **Elena** llevaba   dos espacios\n');
  undo(view);
  assert.equal(state.doc.toString(), 'Primera línea\n\n**Elena** llevaba   dos espacios\n', 'one step undoes the quote only');
  undo(view);
  assert.equal(state.doc.toString(), 'Primera línea\n\nElena llevaba   dos espacios\n');
});

test('a read-only editor is never formatted', () => {
  const state = stateOf('«Elena»', [EditorState.readOnly.of(true)]);
  let dispatched = false;
  const view = { state, dispatch() { dispatched = true; }, focus() {} };
  assert.equal(applyFormat(view, 'bold'), false);
  assert.equal(dispatched, false);
});
