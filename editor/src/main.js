// The review page's scene editor on CodeMirror 6, served as one ES module at /review/editor.js.
// The page (src/adapters/review-page.ts) owns saving, drafts and line endings; this module only
// shows and edits the text. The document is always the Markdown as the person typed it, with
// every line break as \n: the three views are ways of looking at it, never a conversion.
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { Annotation, Compartment, EditorState } from '@codemirror/state';
import { EditorView, keymap, lineNumbers } from '@codemirror/view';
import { tags } from '@lezer/highlight';
import { formatKeymap, formatToolbar } from './format.js';
import { livePreview } from './live-preview.js';
import { markdown } from './markdown.js';
import { renderReading } from './reading.js';
import { setNotes, wikilinkPreview, wikilinks } from './wikilinks.js';

// The page resolves a followed link with the same rules the editor styles it by.
export { noteIndex } from './wikilinks.js';

export const VIEWS = [
  { id: 'live', label: 'Vista previa en vivo' },
  { id: 'source', label: 'Markdown' },
  { id: 'reading', label: 'Lectura' },
];
const isView = (id) => VIEWS.some((view) => view.id === id);

// A change the page made (loading a saved version) rather than the person.
const fromPage = Annotation.define();

// The page's own tokens (docs/design.md), so the editor follows the light and dark themes.
const theme = EditorView.theme({
  '&': { color: 'var(--ink)', backgroundColor: 'transparent', fontSize: 'var(--text-md)' },
  '&.cm-focused': { outline: 'none' },
  '.cm-scroller': { fontFamily: 'var(--font-prose)', lineHeight: '1.7' },
  // Writing comfort: a reading measure, centred, with room below the last line.
  '.cm-content': { maxWidth: '40em', margin: '0 auto', padding: 'var(--space-4) 0 var(--space-7)', caretColor: 'var(--ink)', minHeight: '50vh' },
  '.cm-line': { padding: '0 var(--space-1)' },
  // 16 px at least in every view, so iOS does not zoom the page when the text gets focus.
  '&[data-view=source] .cm-scroller': { fontFamily: 'var(--font-code)', lineHeight: '1.6' },
  '&[data-view=source] .cm-content': { maxWidth: 'none', margin: '0' },
  '.cm-gutters': { backgroundColor: 'transparent', color: 'var(--muted)', border: 'none' },
  '.cm-lp-h1': { fontSize: '1.5em', fontWeight: '700', lineHeight: '1.3' },
  '.cm-lp-h2': { fontSize: '1.3em', fontWeight: '700', lineHeight: '1.3' },
  '.cm-lp-h3': { fontSize: '1.15em', fontWeight: '700' },
  '.cm-lp-h4, .cm-lp-h5, .cm-lp-h6': { fontWeight: '700' },
  '.cm-lp-em': { fontStyle: 'italic' },
  '.cm-lp-strong': { fontWeight: '700' },
  '.cm-lp-strike': { textDecoration: 'line-through' },
  '.cm-lp-code': { fontFamily: 'var(--font-code)', fontSize: '0.9em' },
  '.cm-lp-link': { textDecoration: 'underline', textDecorationColor: 'var(--edge)' },
  '.cm-lp-quote': { borderLeft: '3px solid var(--line)', paddingLeft: 'var(--space-3)', color: 'var(--muted)' },
  '.cm-lp-break': { textAlign: 'center' },
  '.cm-lp-scene-break': { color: 'var(--muted)', letterSpacing: '0.3em' },
  '.cm-lp-bullet': { color: 'var(--muted)' },
  // Wikilinks: a link to a note reads as a link; one that names no note is dashed and muted.
  '.cm-wikilink': { color: 'var(--accept)', textDecoration: 'underline', textDecorationColor: 'var(--accept)', textUnderlineOffset: '0.15em', cursor: 'pointer' },
  '.cm-wikilink-unresolved': { color: 'var(--muted)', textDecorationStyle: 'dashed', textDecorationColor: 'var(--edge)' },
  '.cm-tooltip.cm-tooltip-autocomplete': { backgroundColor: 'var(--paper)', color: 'var(--ink)', border: '1px solid var(--edge)', borderRadius: 'var(--radius)', fontFamily: 'var(--font-ui)' },
  '.cm-tooltip.cm-tooltip-autocomplete > ul > li': { minHeight: 'var(--tap)', display: 'flex', alignItems: 'center', gap: 'var(--space-2)', padding: '0 var(--space-3)' },
  '.cm-tooltip.cm-tooltip-autocomplete > ul > li[aria-selected]': { backgroundColor: 'var(--pressed)', color: 'var(--ink)' },
  '.cm-completionDetail': { color: 'var(--muted)', fontStyle: 'normal' },
});

// Source highlighting: structure in weight and slant, Markdown punctuation muted.
const highlight = HighlightStyle.define([
  { tag: tags.heading, fontWeight: '700' },
  { tag: tags.emphasis, fontStyle: 'italic' },
  { tag: tags.strong, fontWeight: '700' },
  { tag: tags.strikethrough, textDecoration: 'line-through' },
  { tag: [tags.processingInstruction, tags.meta, tags.url, tags.contentSeparator, tags.labelName], color: 'var(--muted)' },
  { tag: tags.quote, color: 'var(--muted)' },
  { tag: tags.monospace, fontFamily: 'var(--font-code)' },
]);

function viewExtension(id) {
  if (id === 'source') return [lineNumbers(), EditorView.editorAttributes.of({ 'data-view': 'source' })];
  return [livePreview, wikilinkPreview, EditorView.editorAttributes.of({ 'data-view': 'live' })];
}

const editability = (editable) => [EditorView.editable.of(editable), EditorState.readOnly.of(!editable)];

/**
 * Builds an editor. `onChange` runs after each edit by the person, `onSave` on Ctrl/Cmd+S,
 * `onViewChange` when the person picks another view. `notes` ({ name, type, aliases }) are the
 * book's notes that wikilinks resolve and `[[` completes against, and `onOpenNote(target)` runs
 * when the person follows a link. Returns the same small surface as the page's plain text
 * field: dom, getValue, setValue, setEditable, isEditable, getSelection, select, focus, destroy,
 * plus setNotes. A formatting toolbar (format.js) sits between the views and the text. New behaviour belongs in its own extension module added to the list below, as
 * live-preview.js and wikilinks.js are.
 */
export function createSceneEditor({ text, label, view = 'live', notes = [], onChange = () => {}, onSave = () => {}, onViewChange = () => {}, onOpenNote = () => {} }) {
  const doc = document;
  let current = isView(view) ? view : 'live';
  let editable = true;
  const root = doc.createElement('div');
  root.className = 'scene-cm';
  const bar = doc.createElement('div');
  bar.className = 'scene-views';
  bar.setAttribute('role', 'group');
  bar.setAttribute('aria-label', 'Vista del editor');
  const host = doc.createElement('div');
  host.className = 'scene-cm-host';
  const reading = doc.createElement('div');
  reading.className = 'scene-reading';
  reading.setAttribute('aria-label', 'Lectura de la escena');
  const modeSlot = new Compartment();
  // Set right after the view exists; the first updates happen before it.
  let format = null;
  const editSlot = new Compartment();

  const cm = new EditorView({
    parent: host,
    state: EditorState.create({
      doc: text,
      extensions: [
        history(),
        keymap.of([
          { key: 'Mod-s', preventDefault: true, run: () => { onSave(); return true; } },
          ...formatKeymap,
          ...defaultKeymap,
          ...historyKeymap,
        ]),
        markdown(),
        syntaxHighlighting(highlight),
        EditorView.lineWrapping,
        // Phone keyboards: the browser's spelling, autocorrect and capitals, as in a text field.
        EditorView.contentAttributes.of({ 'aria-label': label, spellcheck: 'true', autocorrect: 'on', autocapitalize: 'sentences' }),
        EditorView.updateListener.of((update) => {
          if ((update.docChanged || update.selectionSet) && format) format.refresh(update.state);
          if (update.docChanged && !update.transactions.some((tr) => tr.annotation(fromPage))) onChange();
        }),
        theme,
        wikilinks({ notes, onOpen: (target) => onOpenNote(target) }),
        modeSlot.of(viewExtension(current)),
        editSlot.of(editability(true)),
      ],
    }),
  });

  const buttons = VIEWS.map(({ id, label: name }) => {
    const btn = doc.createElement('button');
    btn.type = 'button';
    btn.textContent = name;
    btn.dataset.view = id;
    btn.addEventListener('click', () => {
      if (current === id) return;
      show(id);
      onViewChange(id);
    });
    return btn;
  });
  bar.append(...buttons);
  // The formatting toolbar (format.js) edits the same text; Lectura has nothing to format.
  format = formatToolbar(cm, doc);
  format.refresh(cm.state);
  root.append(bar, format.dom, host, reading);

  function show(id) {
    current = id;
    for (const btn of buttons) btn.setAttribute('aria-pressed', String(btn.dataset.view === id));
    root.dataset.view = id;
    const isReading = id === 'reading';
    if (isReading) renderReading(reading, cm.state.doc.toString());
    else reading.replaceChildren();
    reading.hidden = !isReading;
    host.hidden = isReading;
    format.dom.hidden = isReading;
    cm.dispatch({ effects: modeSlot.reconfigure(viewExtension(id)) });
  }
  show(current);

  return {
    dom: root,
    getValue: () => cm.state.doc.toString(),
    setValue(value) {
      cm.dispatch({ changes: { from: 0, to: cm.state.doc.length, insert: value }, annotations: fromPage.of(true) });
      if (current === 'reading') renderReading(reading, value);
    },
    setEditable(value) {
      editable = value;
      cm.dispatch({ effects: editSlot.reconfigure(editability(value)) });
      format.setDisabled(!value);
    },
    isEditable: () => editable,
    setNotes(list) {
      cm.dispatch({ effects: setNotes.of(list) });
    },
    // Selects [from, to) of the text and scrolls it to the middle of the editor. The reading
    // view cannot show a selection, so it gives way to the live preview (not remembered).
    // The selection as [from, to) and its text, for the page's "Analizar" (empty when none).
    getSelection() {
      const { from, to } = cm.state.selection.main;
      return { from, to, text: cm.state.sliceDoc(from, to) };
    },
    select(from, to) {
      if (current === 'reading') show('live');
      const end = Math.max(0, Math.min(to, cm.state.doc.length));
      const start = Math.max(0, Math.min(from, end));
      cm.dispatch({ selection: { anchor: start, head: end }, effects: EditorView.scrollIntoView(start, { y: 'center' }) });
      cm.focus();
    },
    focus() {
      if (current === 'reading') buttons.find((btn) => btn.dataset.view === 'reading').focus();
      else cm.focus();
    },
    destroy: () => cm.destroy(),
  };
}

/* global __GRAPH_CHUNK__ */
// The Grafo drawing (issue #115) is a separate chunk next to this module, named by the build,
// so opening the editor never downloads it. Rejects when the chunk is missing.
export function loadGraphView() {
  if (typeof __GRAPH_CHUNK__ !== 'string') return Promise.reject(new Error('the graph view is not built'));
  return import(new URL(__GRAPH_CHUNK__, import.meta.url).href);
}
