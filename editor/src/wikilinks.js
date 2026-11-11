// Wikilinks in the scene editor (issue #115): [[Nota]], [[Nota|texto]] and [[Nota#Sección]]. In
// "Vista previa en vivo" a link shows only its text, away from the lines the cursor touches, and
// a link that names no note looks different; a click on it (or Enter with the cursor inside it)
// opens the note; typing [[ offers the book's notes and aliases. "Markdown" shows links raw.
// Links are read and resolved by the server's rules (src/domain/wikilink.ts, story-graph.ts).
import { autocompletion } from '@codemirror/autocomplete';
import { syntaxTree } from '@codemirror/language';
import { Prec, StateEffect, StateField } from '@codemirror/state';
import { Decoration, EditorView, ViewPlugin, keymap } from '@codemirror/view';

/** The server's foldName: NFD, combining marks removed, lower case, whitespace runs as one space, trimmed. */
export function foldName(name) {
  return String(name).normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/\s+/gu, ' ').trim();
}

const byCodeUnit = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/** Resolves a link target like the server's NoteIndex: a name wins over an alias; two matches are ambiguous. */
export function noteIndex(notes) {
  const names = new Map();
  const aliases = new Map();
  const add = (map, key, name) => {
    if (!key) return;
    const list = map.get(key) || [];
    if (!list.includes(name)) list.push(name);
    map.set(key, list);
  };
  for (const note of notes) {
    add(names, foldName(note.name), note.name);
    for (const alias of note.aliases || []) add(aliases, foldName(alias), note.name);
  }
  return {
    notes,
    resolve(target) {
      const key = foldName(target);
      for (const map of [names, aliases]) {
        const found = [...(map.get(key) || [])].sort(byCodeUnit);
        if (found.length === 1) return { status: 'resolved', note: found[0] };
        if (found.length > 1) return { status: 'ambiguous', candidates: found };
      }
      return { status: 'unresolved' };
    },
  };
}

/**
 * The links in one line of text starting at document position `offset`, read like the server's
 * parseWikilinks (code is checked by the caller). `shownFrom`/`shownTo` is the part a reader sees:
 * the text after `|`, or the target without its section.
 */
export function wikilinksIn(text, offset) {
  const links = [];
  let i = 0;
  while ((i = text.indexOf('[[', i)) !== -1) {
    let j = i + 2;
    while (j < text.length && !'[]\n\r'.includes(text[j])) j += 1;
    if (text[j] !== ']' || text[j + 1] !== ']') { i = j > i + 2 ? j : i + 1; continue; }
    const end = j + 2;
    if (!(i > 0 && text[i - 1] === '!')) {
      const link = readInner(text, i + 2, j);
      if (link) links.push({ from: offset + i, to: offset + end, target: link.target, shownFrom: offset + link.shownFrom, shownTo: offset + link.shownTo });
    }
    i = end;
  }
  return links;
}

function readInner(text, from, to) {
  const inner = text.slice(from, to);
  const bar = inner.indexOf('|');
  const left = bar === -1 ? inner : inner.slice(0, bar);
  const hash = left.indexOf('#');
  const rawTarget = hash === -1 ? left : left.slice(0, hash);
  const target = rawTarget.trim();
  const section = hash === -1 ? null : left.slice(hash + 1).trim();
  if (!target || (section && section.startsWith('^'))) return null;
  if (bar !== -1) {
    const label = inner.slice(bar + 1);
    if (label.trim()) {
      const lead = label.length - label.trimStart().length;
      return { target, shownFrom: from + bar + 1 + lead, shownTo: from + bar + 1 + lead + label.trim().length };
    }
  }
  const lead = rawTarget.length - rawTarget.trimStart().length;
  return { target, shownFrom: from + lead, shownTo: from + lead + target.length };
}

// Code spans and fenced blocks hold no links, as on the server.
function inCode(state, pos) {
  for (let node = syntaxTree(state).resolveInner(pos, 1); node; node = node.parent) {
    if (node.name === 'InlineCode' || node.name === 'FencedCode') return true;
  }
  return false;
}

function linksOfLine(state, line) {
  return wikilinksIn(line.text, line.from).filter((link) => !inCode(state, link.from));
}

/** The link whose brackets hold `pos` (from just after `[[` to just before `]]`), or null. */
export function linkAt(state, pos) {
  const line = state.doc.lineAt(pos);
  return linksOfLine(state, line).find((link) => pos >= link.from + 2 && pos <= link.to - 2) || null;
}

function activeLines(state) {
  const lines = new Set();
  for (const range of state.selection.ranges) {
    const last = state.doc.lineAt(range.to).number;
    for (let n = state.doc.lineAt(range.from).number; n <= last; n += 1) lines.add(n);
  }
  return lines;
}

const classOf = (index, target) => (index.resolve(target).status === 'resolved' ? 'cm-wikilink' : 'cm-wikilink cm-wikilink-unresolved');

/**
 * What live preview does to the links in the visible ranges, as plain data for tests:
 * { kind: 'hide' | 'mark', from, to, cls?, target? }. Away from the cursor the brackets, the
 * target before `|` and the section are hidden; on the cursor's lines the whole link is marked.
 */
export function wikilinkRanges(state, visible, index) {
  const active = activeLines(state);
  const out = [];
  const seen = new Set();
  for (const { from, to } of visible) {
    for (let n = state.doc.lineAt(from).number, last = state.doc.lineAt(to).number; n <= last; n += 1) {
      if (seen.has(n)) continue;
      seen.add(n);
      const line = state.doc.line(n);
      for (const link of linksOfLine(state, line)) {
        const cls = classOf(index, link.target);
        if (active.has(n)) {
          out.push({ kind: 'mark', from: link.from, to: link.to, cls, target: link.target });
          continue;
        }
        out.push({ kind: 'hide', from: link.from, to: link.shownFrom });
        out.push({ kind: 'mark', from: link.shownFrom, to: link.shownTo, cls, target: link.target });
        out.push({ kind: 'hide', from: link.shownTo, to: link.to });
      }
    }
  }
  return out;
}

/**
 * Completions for `[[` before `pos`: note names and aliases whose folded form contains what was
 * typed, prefix matches first. An alias inserts `Name|alias`, so the link shows the alias and
 * still names the note. Closing brackets are added unless they already follow. null when the
 * cursor is not in a link target.
 */
export function completeWikilink(state, pos, notes) {
  const line = state.doc.lineAt(pos);
  const before = line.text.slice(0, pos - line.from);
  const match = /(^|[^!])\[\[([^[\]|#\n]*)$/.exec(before);
  if (!match || inCode(state, pos - match[2].length - 1)) return null;
  const typed = foldName(match[2]);
  const closed = line.text.slice(pos - line.from, pos - line.from + 2) === ']]';
  const close = closed ? '' : ']]';
  const options = [];
  for (const note of notes) {
    options.push({ label: note.name, insert: note.name + close, detail: note.type || undefined, key: foldName(note.name) });
    for (const alias of note.aliases || []) options.push({ label: alias, insert: note.name + '|' + alias + close, detail: note.name, key: foldName(alias) });
  }
  const rank = (option) => (option.key.startsWith(typed) ? 0 : 1);
  const found = options
    .filter((option) => option.key.includes(typed))
    .sort((a, b) => rank(a) - rank(b) || byCodeUnit(a.key, b.key))
    .map(({ key, ...option }) => option);
  return { from: pos - match[2].length, to: pos, options: found };
}

/** Replaces the book's notes (names, types, aliases) the editor resolves and completes against. */
export const setNotes = StateEffect.define();

const notesField = StateField.define({
  create: () => noteIndex([]),
  update(value, tr) {
    for (const effect of tr.effects) if (effect.is(setNotes)) return noteIndex(effect.value);
    return value;
  },
});

const hidden = Decoration.replace({});
function decorations(view) {
  const index = view.state.field(notesField);
  return Decoration.set(wikilinkRanges(view.state, view.visibleRanges, index).map((r) => (r.kind === 'hide'
    ? hidden.range(r.from, r.to)
    : Decoration.mark({ class: r.cls, attributes: { 'data-wikilink': r.target } }).range(r.from, r.to))), true);
}

/** The live preview's link decorations; the source view leaves links raw. */
export const wikilinkPreview = ViewPlugin.fromClass(
  class {
    constructor(view) {
      this.decorations = decorations(view);
    }
    update(update) {
      const notesChanged = update.transactions.some((tr) => tr.effects.some((effect) => effect.is(setNotes)));
      if (notesChanged || update.docChanged || update.viewportChanged || update.selectionSet || syntaxTree(update.startState) !== syntaxTree(update.state)) {
        this.decorations = decorations(update.view);
      }
    }
  },
  { decorations: (plugin) => plugin.decorations },
);

/**
 * Link behaviour common to every view: the notes field, `[[` completion, Enter or Mod-Enter
 * inside a link, and a click on a link shown as text (or Mod-click anywhere on a link).
 * `onOpen(target)` receives the link's target as written.
 */
export function wikilinks({ notes = [], onOpen = () => {} } = {}) {
  const open = (view, pos) => {
    const link = linkAt(view.state, pos);
    if (!link) return false;
    onOpen(link.target);
    return true;
  };
  return [
    notesField.init(() => noteIndex(notes)),
    autocompletion({
      override: [(context) => {
        const found = completeWikilink(context.state, context.pos, context.state.field(notesField).notes);
        if (!found || (!found.options.length && !context.explicit)) return null;
        return {
          from: found.from,
          to: found.to,
          filter: false,
          options: found.options.map((option) => ({ label: option.label, detail: option.detail, type: 'text', apply: option.insert })),
        };
      }],
      icons: false,
    }),
    Prec.high(keymap.of([
      { key: 'Enter', run: (view) => view.state.selection.main.empty && open(view, view.state.selection.main.head) },
      { key: 'Mod-Enter', run: (view) => open(view, view.state.selection.main.head) },
    ])),
    EditorView.domEventHandlers({
      mousedown(event, view) {
        const element = event.target instanceof Element ? event.target.closest('[data-wikilink]') : null;
        if (!element || event.button !== 0) return false;
        const pos = view.posAtDOM(element);
        const line = view.state.doc.lineAt(pos).number;
        const onActiveLine = activeLines(view.state).has(line);
        if (onActiveLine && !(event.ctrlKey || event.metaKey)) return false;
        event.preventDefault();
        onOpen(element.getAttribute('data-wikilink'));
        return true;
      },
    }),
  ];
}
