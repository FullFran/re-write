// The formatting toolbar of the scene editor (issue #101): Negrita, Cursiva, Título 1-3, Cita,
// Lista, Lista numerada, Separador de escena and Enlace a nota. Every action edits the raw
// Markdown exactly as typing would, in one transaction that is its own undo step; nothing is
// converted or normalised around it. Each action toggles: applied where it is missing, removed
// where every touched place already has it.
//
// The rules are pure functions of an EditorState returning a transaction spec (or null when
// there is nothing to do), so they are tested without a browser; formatToolbar wires them to
// buttons and formatKeymap to Ctrl/Cmd+B and Ctrl/Cmd+I.
import { startCompletion } from '@codemirror/autocomplete';
import { isolateHistory } from '@codemirror/commands';
import { EditorSelection } from '@codemirror/state';

// The marker the imports and the live preview read as a scene break (docs/design.md).
export const SCENE_BREAK = '***';

const STAR = '*';

// The run of `*` that ends at `pos` (looking left) or starts at it (looking right).
function starsBefore(text, pos) {
  let n = 0;
  while (pos - n - 1 >= 0 && text[pos - n - 1] === STAR) n += 1;
  return n;
}
function starsAfter(text, pos) {
  let n = 0;
  while (pos + n < text.length && text[pos + n] === STAR) n += 1;
  return n;
}

// Whether a run of stars on both sides carries the emphasis of `size` (1 italic, 2 bold):
// `*` is italic, `**` bold, `***` both.
const carries = (run, size) => (size === 2 ? run >= 2 : run === 1 || run >= 3);

// The non-blank part of each line [from, to) touches, without its outer spaces: emphasis
// cannot cross a paragraph, nor start or end on a space, in Markdown.
function segments(state, from, to) {
  const out = [];
  const first = state.doc.lineAt(from).number;
  const last = state.doc.lineAt(to).number;
  for (let n = first; n <= last; n += 1) {
    const line = state.doc.line(n);
    let start = Math.max(from, line.from);
    let end = Math.min(to, line.to);
    while (start < end && /\s/.test(state.doc.sliceString(start, start + 1))) start += 1;
    while (end > start && /\s/.test(state.doc.sliceString(end - 1, end))) end -= 1;
    if (end > start) out.push({ from: start, to: end });
  }
  return out;
}

// The word around a cursor (letters, digits, inner apostrophes and hyphens), or null.
function wordAt(state, pos) {
  const line = state.doc.lineAt(pos);
  const text = line.text;
  const at = pos - line.from;
  const isWord = (ch) => /[\p{L}\p{N}'’-]/u.test(ch);
  let start = at;
  let end = at;
  while (start > 0 && isWord(text[start - 1])) start -= 1;
  while (end < text.length && isWord(text[end])) end += 1;
  return end > start ? { from: line.from + start, to: line.from + end } : null;
}

// How a segment [from, to) carries the emphasis: markers inside it, outside it, or none.
function emphasisOf(text, seg, size) {
  const inner = text.slice(seg.from, seg.to);
  const lead = starsAfter(inner, 0);
  const tail = starsBefore(inner, inner.length);
  if (lead < inner.length && carries(lead, size) && carries(tail, size)) return 'inside';
  if (carries(starsBefore(text, seg.from), size) && carries(starsAfter(text, seg.to), size)) return 'outside';
  return null;
}

/**
 * Negrita (size 2, `**`) or Cursiva (size 1, `*`) over the selection. A cursor inside a word
 * acts on that word; a cursor elsewhere inserts an empty pair and stands between its markers,
 * or removes the empty pair it stands in. Several lines are handled line by line.
 */
export function toggleEmphasis(state, size) {
  const marker = STAR.repeat(size);
  const text = state.doc.toString();
  const plans = [];
  for (const range of state.selection.ranges) {
    if (range.empty) {
      const word = wordAt(state, range.head);
      if (word) plans.push({ range, segs: [word] });
      else plans.push({ range, segs: [], cursor: range.head });
    } else {
      plans.push({ range, segs: segments(state, range.from, range.to) });
    }
  }
  const all = plans.flatMap((p) => p.segs);
  const removing = all.length > 0 && all.every((seg) => emphasisOf(text, seg, size));
  const changes = [];
  for (const plan of plans) {
    if (plan.cursor !== undefined) {
      const pos = plan.cursor;
      plan.inserted = !(text.slice(pos - size, pos) === marker && text.slice(pos, pos + size) === marker && carries(starsBefore(text, pos), size));
      changes.push(plan.inserted ? { from: pos, insert: marker + marker } : { from: pos - size, to: pos + size });
      continue;
    }
    for (const seg of plan.segs) {
      const how = emphasisOf(text, seg, size);
      if (removing && how === 'inside') {
        // From a run of three stars the one or two nearest the words go.
        const lead = seg.from + starsAfter(text, seg.from);
        const tail = seg.to - starsBefore(text, seg.to);
        changes.push({ from: lead - size, to: lead }, { from: tail, to: tail + size });
      } else if (removing) {
        changes.push({ from: seg.from - size, to: seg.from }, { from: seg.to, to: seg.to + size });
      } else if (!how) {
        changes.push({ from: seg.from, insert: marker }, { from: seg.to, insert: marker });
      }
    }
  }
  if (!changes.length) return null;
  const set = state.changes(changes);
  // The selection keeps the same words; a fresh empty pair puts the cursor between its markers.
  const ranges = plans.map((plan) => {
    if (plan.cursor !== undefined) {
      const at = set.mapPos(plan.cursor, -1);
      return EditorSelection.cursor(plan.inserted ? at + size : at);
    }
    if (plan.range.empty) return EditorSelection.cursor(set.mapPos(plan.range.head, 1));
    // On one line the selection keeps the words, so typing replaces them and keeps the style;
    // over several lines it takes the new markers in, so a second press finds them.
    const lines = state.doc.lineAt(plan.range.from).number !== state.doc.lineAt(plan.range.to).number;
    const out = lines ? -1 : 1;
    const forward = plan.range.anchor <= plan.range.head;
    return EditorSelection.range(set.mapPos(plan.range.anchor, forward ? out : -out), set.mapPos(plan.range.head, forward ? -out : out));
  });
  return { changes: set, selection: EditorSelection.create(ranges, state.selection.mainIndex) };
}

// The lines the selection touches, once each; a selection ending at the very start of a line
// does not touch that line. Blank lines count only when nothing else is touched.
function touchedLines(state) {
  const seen = new Set();
  const lines = [];
  for (const range of state.selection.ranges) {
    const first = state.doc.lineAt(range.from).number;
    let last = state.doc.lineAt(range.to).number;
    if (last > first && state.doc.line(last).from === range.to) last -= 1;
    for (let n = first; n <= last; n += 1) {
      if (seen.has(n)) continue;
      seen.add(n);
      lines.push(state.doc.line(n));
    }
  }
  const filled = lines.filter((line) => line.text.trim() !== '');
  return filled.length ? filled : lines;
}

// Line prefixes, as CommonMark reads them (up to three spaces of indentation before a block).
const HEADING = /^( {0,3})(#{1,6})(?:[ \t]+|$)/;
const QUOTE = /^( {0,3})> ?/;
const BULLET = /^(\s*)[-+*][ \t]+/;
const ORDERED = /^(\s*)\d{1,9}[.)][ \t]+/;
const LIST = /^(\s*)(?:[-+*]|\d{1,9}[.)])[ \t]+/;

/** The kind of line prefix a line carries for `kind`: 'h1'..'h3', 'quote', 'bullet', 'ordered'. */
export function hasPrefix(text, kind) {
  if (kind === 'quote') return QUOTE.test(text);
  if (kind === 'bullet') return BULLET.test(text) && !/^\s*\*{3,}\s*$/.test(text) && !/^\s*[-*+][ \t]+[-*+][ \t]+[-*+]/.test(text);
  if (kind === 'ordered') return ORDERED.test(text);
  const heading = HEADING.exec(text);
  return Boolean(heading) && heading[2].length === Number(kind.slice(1));
}

// The change that gives one line the prefix of `kind` (number is the item's number in a
// numbered list), replacing the competing prefix of the same family.
function addPrefix(line, kind, number) {
  if (kind === 'quote') return { from: line.from, insert: '> ' };
  if (kind === 'bullet' || kind === 'ordered') {
    const mark = kind === 'bullet' ? '- ' : number + '. ';
    const list = LIST.exec(line.text);
    if (list) return { from: line.from + list[1].length, to: line.from + list[0].length, insert: mark };
    const indent = /^\s*/.exec(line.text)[0].length;
    return { from: line.from + indent, insert: mark };
  }
  const mark = '#'.repeat(Number(kind.slice(1))) + ' ';
  const heading = HEADING.exec(line.text);
  if (heading) return { from: line.from + heading[1].length, to: line.from + heading[0].length, insert: mark };
  return { from: line.from, insert: mark };
}

function removePrefix(line, kind) {
  const pattern = kind === 'quote' ? QUOTE : kind === 'bullet' ? BULLET : kind === 'ordered' ? ORDERED : HEADING;
  const found = pattern.exec(line.text);
  return { from: line.from + found[1].length, to: line.from + found[0].length };
}

/**
 * Título 1-3 ('h1'..'h3'), Cita ('quote'), Lista ('bullet') and Lista numerada ('ordered') on
 * every line the selection touches: removed when they all have it, else given to each (a
 * heading or list prefix of another kind is replaced; a numbered list counts from 1).
 */
export function toggleLinePrefix(state, kind) {
  const lines = touchedLines(state);
  const removing = lines.every((line) => hasPrefix(line.text, kind));
  const changes = [];
  let number = 0;
  for (const line of lines) {
    if (removing) changes.push(removePrefix(line, kind));
    else {
      number += 1;
      if (!hasPrefix(line.text, kind) || kind === 'ordered') changes.push(addPrefix(line, kind, number));
    }
  }
  const set = state.changes(changes);
  if (set.empty) return null;
  // A cursor at the start of a line follows the new prefix, so the next key types after it; a
  // selection keeps covering whole lines.
  const ranges = state.selection.ranges.map((r) => {
    if (r.empty) return EditorSelection.cursor(set.mapPos(r.head, 1));
    const forward = r.anchor <= r.head;
    return EditorSelection.range(set.mapPos(r.anchor, forward ? -1 : 1), set.mapPos(r.head, forward ? 1 : -1));
  });
  return { changes: set, selection: EditorSelection.create(ranges, state.selection.mainIndex) };
}

const isBreak = (text) => /^ {0,3}(?:\*[ \t]*){3,}$/.test(text);

/**
 * Separador de escena: `***` on a line of its own, with a blank line on each side, after the
 * line the cursor is on; the cursor goes to the line after it. On a line that already is a
 * scene break, the break is removed with its line.
 */
export function toggleSceneBreak(state) {
  const head = state.selection.main.head;
  const line = state.doc.lineAt(head);
  if (isBreak(line.text)) {
    const from = line.number > 1 ? line.from - 1 : line.from;
    const to = line.number > 1 ? line.to : Math.min(line.to + 1, state.doc.length);
    return { changes: { from, to }, selection: EditorSelection.cursor(from) };
  }
  const blank = line.text.trim() === '';
  const prev = line.number > 1 ? state.doc.line(line.number - 1) : null;
  const next = line.number < state.doc.lines ? state.doc.line(line.number + 1) : null;
  let insert;
  let at;
  if (blank) {
    // The break takes the empty line; a blank line is added only where text touches it.
    at = line.from;
    insert = (prev && prev.text.trim() !== '' ? '\n' : '') + SCENE_BREAK + (next ? (next.text.trim() !== '' ? '\n' : '') : '\n\n');
  } else {
    at = line.to;
    insert = '\n\n' + SCENE_BREAK + (next ? (next.text.trim() !== '' ? '\n' : '') : '\n\n');
  }
  const changes = state.changes({ from: at, to: blank ? line.to : at, insert });
  // The cursor goes past the break and the blank line after it.
  const doc = changes.apply(state.doc);
  const breakLine = doc.lineAt(at + insert.indexOf(SCENE_BREAK)).number;
  const cursor = breakLine + 2 <= doc.lines ? doc.line(breakLine + 2).from : doc.length;
  return { changes, selection: EditorSelection.cursor(cursor) };
}

/**
 * Enlace a nota: a selection becomes `[[selection]]` (or loses the brackets it already has);
 * a cursor gets `[[`, and the toolbar then opens the note completion, which adds the `]]`.
 */
export function toggleWikilink(state) {
  const range = state.selection.main;
  const text = state.doc.toString();
  if (range.empty) {
    return { changes: { from: range.head, insert: '[[' }, selection: EditorSelection.cursor(range.head + 2) };
  }
  const inner = text.slice(range.from, range.to);
  if (inner.startsWith('[[') && inner.endsWith(']]') && inner.length >= 4) {
    return { changes: [{ from: range.from, to: range.from + 2 }, { from: range.to - 2, to: range.to }], selection: EditorSelection.range(range.from, range.to - 4) };
  }
  if (text.slice(range.from - 2, range.from) === '[[' && text.slice(range.to, range.to + 2) === ']]') {
    return { changes: [{ from: range.from - 2, to: range.from }, { from: range.to, to: range.to + 2 }], selection: EditorSelection.range(range.from - 2, range.to - 2) };
  }
  return { changes: [{ from: range.from, insert: '[[' }, { from: range.to, insert: ']]' }], selection: EditorSelection.range(range.from + 2, range.to + 2) };
}

/** Which actions are on where the main selection is, for the buttons' aria-pressed. */
export function formatState(state) {
  const text = state.doc.toString();
  const range = state.selection.main;
  const seg = range.empty ? wordAt(state, range.head) : segments(state, range.from, range.to)[0];
  const line = state.doc.lineAt(range.head).text;
  const on = {};
  for (const [id, size] of [['bold', 2], ['italic', 1]]) on[id] = Boolean(seg && emphasisOf(text, seg, size));
  for (const kind of ['h1', 'h2', 'h3', 'quote', 'bullet', 'ordered']) on[kind] = hasPrefix(line, kind);
  return on;
}

// The actions, in toolbar order: id, visible label, rule, keyboard shortcut.
export const FORMATS = [
  { id: 'bold', label: 'Negrita', run: (s) => toggleEmphasis(s, 2), keys: 'Mod-b', aria: 'Control+B' },
  { id: 'italic', label: 'Cursiva', run: (s) => toggleEmphasis(s, 1), keys: 'Mod-i', aria: 'Control+I' },
  { id: 'h1', label: 'Título 1', run: (s) => toggleLinePrefix(s, 'h1') },
  { id: 'h2', label: 'Título 2', run: (s) => toggleLinePrefix(s, 'h2') },
  { id: 'h3', label: 'Título 3', run: (s) => toggleLinePrefix(s, 'h3') },
  { id: 'quote', label: 'Cita', run: (s) => toggleLinePrefix(s, 'quote') },
  { id: 'bullet', label: 'Lista', run: (s) => toggleLinePrefix(s, 'bullet') },
  { id: 'ordered', label: 'Lista numerada', run: (s) => toggleLinePrefix(s, 'ordered') },
  { id: 'break', label: 'Separador de escena', run: toggleSceneBreak, toggle: false },
  { id: 'link', label: 'Enlace a nota', run: toggleWikilink, toggle: false },
];

/** Runs one action on a view: one transaction, its own undo step. False when nothing changed. */
export function applyFormat(view, id) {
  const format = FORMATS.find((f) => f.id === id);
  if (!format || view.state.readOnly) return false;
  const spec = format.run(view.state);
  if (!spec) return false;
  view.dispatch({ ...spec, scrollIntoView: true, userEvent: 'input.format', annotations: isolateHistory.of('full') });
  // `[[` at the cursor: the note list opens as if the person had typed it.
  if (id === 'link' && view.state.selection.main.empty) startCompletion(view);
  return true;
}

/** Ctrl/Cmd+B and Ctrl/Cmd+I, for the editor's keymap. */
export const formatKeymap = FORMATS.filter((f) => f.keys).map((f) => ({ key: f.keys, preventDefault: true, run: (view) => applyFormat(view, f.id) || true }));

/**
 * The toolbar for a view. On a phone it folds behind one **Formato** button (the page's CSS
 * decides when the fold shows). The buttons never take the focus from the text, so the
 * selection they act on stays. Returns { dom, refresh(state), setDisabled(on) }.
 */
export function formatToolbar(view, doc = document) {
  const dom = doc.createElement('div');
  dom.className = 'scene-format';
  dom.setAttribute('role', 'group');
  dom.setAttribute('aria-label', 'Formato');
  const toggle = doc.createElement('button');
  toggle.type = 'button';
  toggle.className = 'format-toggle';
  toggle.textContent = 'Formato';
  toggle.setAttribute('aria-expanded', 'false');
  const list = doc.createElement('div');
  list.className = 'format-buttons';
  list.id = 'format-' + Math.random().toString(36).slice(2, 10);
  toggle.setAttribute('aria-controls', list.id);
  toggle.addEventListener('click', () => {
    const open = toggle.getAttribute('aria-expanded') !== 'true';
    toggle.setAttribute('aria-expanded', String(open));
    dom.dataset.open = String(open);
  });
  const buttons = FORMATS.map((format) => {
    const btn = doc.createElement('button');
    btn.type = 'button';
    btn.textContent = format.label;
    btn.dataset.format = format.id;
    if (format.aria) btn.setAttribute('aria-keyshortcuts', format.aria);
    if (format.toggle !== false) btn.setAttribute('aria-pressed', 'false');
    // The text keeps the focus, and so the selection, while a button is pressed.
    btn.addEventListener('mousedown', (event) => event.preventDefault());
    btn.addEventListener('click', () => {
      applyFormat(view, format.id);
      view.focus();
    });
    return btn;
  });
  list.append(...buttons);
  dom.append(toggle, list);
  return {
    dom,
    refresh(state) {
      const on = formatState(state);
      for (const btn of buttons) if (btn.hasAttribute('aria-pressed')) btn.setAttribute('aria-pressed', String(Boolean(on[btn.dataset.format])));
    },
    setDisabled(disabled) {
      for (const btn of buttons) btn.disabled = disabled;
    },
  };
}
