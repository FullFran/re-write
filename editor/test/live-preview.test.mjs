import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EditorSelection, EditorState } from '@codemirror/state';
import { ensureSyntaxTree } from '@codemirror/language';
import { markdown } from '../src/markdown.js';
import { previewRanges } from '../src/live-preview.js';

function preview(text, cursor) {
  const state = EditorState.create({ doc: text, extensions: [markdown()], selection: EditorSelection.cursor(cursor) });
  ensureSyntaxTree(state, state.doc.length, 5000);
  const ranges = previewRanges(state, [{ from: 0, to: state.doc.length }]);
  return ranges.map((r) => [r.kind, text.slice(r.from, r.to), r.cls ?? null]);
}

const TEXT = '# Uno\n\nElla *dudó* y **corrió**.\n\n> Nadie.\n\n- lista\n\n***\n';

test('live preview hides every marker away from the cursor and styles headings, emphasis, quotes, lists and breaks', () => {
  // The cursor sits at the end, on the empty last line.
  const got = preview(TEXT, TEXT.length);
  assert.deepEqual(got, [
    ['line', '', 'cm-lp-h1'],
    ['hide', '# ', null],
    ['hide', '*', null],
    ['mark', '*dudó*', 'cm-lp-em'],
    ['hide', '*', null],
    ['hide', '**', null],
    ['mark', '**corrió**', 'cm-lp-strong'],
    ['hide', '**', null],
    ['line', '', 'cm-lp-quote'],
    ['hide', '> ', null],
    ['bullet', '-', null],
    ['line', '', 'cm-lp-break'],
    ['break', '***', null],
  ]);
});

test('live preview shows the markers of the line with the cursor, and only that line', () => {
  const onEmphasis = TEXT.indexOf('dudó');
  const got = preview(TEXT, onEmphasis);
  assert.ok(!got.some(([kind, text]) => kind === 'hide' && (text === '*' || text === '**')), 'the line with the cursor keeps its markers');
  assert.ok(got.some(([kind, text]) => kind === 'hide' && text === '# '), 'other lines still hide theirs');
  assert.ok(got.some(([kind, text, cls]) => kind === 'mark' && text === '*dudó*' && cls === 'cm-lp-em'), 'the styling stays');
  const onBreak = preview(TEXT, TEXT.indexOf('***') + 1);
  assert.ok(!onBreak.some(([kind]) => kind === 'break'), 'a scene break under the cursor shows its source');
});
