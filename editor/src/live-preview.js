// "Vista previa en vivo": the Markdown stays the document, and decorations hide its
// markers everywhere except on the lines the cursor or the selection touches, where the
// person is writing. Headings, emphasis, quotes, lists and scene breaks are styled in place.
import { syntaxTree } from '@codemirror/language';
import { Decoration, ViewPlugin, WidgetType } from '@codemirror/view';

const HEADING = /^(?:ATX|Setext)Heading(\d)$/;
const INLINE = { Emphasis: 'cm-lp-em', StrongEmphasis: 'cm-lp-strong', Strikethrough: 'cm-lp-strike', InlineCode: 'cm-lp-code', Link: 'cm-lp-link' };
const INLINE_MARKS = new Set(['EmphasisMark', 'StrikethroughMark', 'CodeMark']);
// At one position, line styles come first, then what replaces text, then what styles it.
const ORDER = { line: 0, hide: 1, bullet: 1, break: 1, mark: 2 };

function activeLines(state) {
  const lines = new Set();
  for (const range of state.selection.ranges) {
    const last = state.doc.lineAt(range.to).number;
    for (let n = state.doc.lineAt(range.from).number; n <= last; n += 1) lines.add(n);
  }
  return lines;
}

/**
 * What live preview does to the visible ranges, as plain data so it can be tested
 * without a browser: { kind: 'line' | 'hide' | 'mark' | 'bullet' | 'break', from, to, cls? }.
 */
export function previewRanges(state, visible) {
  const doc = state.doc;
  const active = activeLines(state);
  const isActive = (pos) => active.has(doc.lineAt(pos).number);
  const out = [];
  const lineStyle = (from, to, cls) => {
    for (let n = doc.lineAt(from).number, last = doc.lineAt(to).number; n <= last; n += 1) {
      const line = doc.line(n);
      out.push({ kind: 'line', from: line.from, to: line.from, cls });
    }
  };
  // A marker followed by its separating space hides both.
  const hideSpaced = (from, to) => {
    if (isActive(from)) return;
    out.push({ kind: 'hide', from, to: doc.sliceString(to, to + 1) === ' ' ? to + 1 : to });
  };
  const tree = syntaxTree(state);
  for (const { from, to } of visible) {
    tree.iterate({
      from,
      to,
      enter: (node) => {
        const name = node.name;
        const heading = HEADING.exec(name);
        if (heading) lineStyle(node.from, node.to, 'cm-lp-h' + heading[1]);
        else if (name === 'HeaderMark') hideSpaced(node.from, node.to);
        else if (name === 'Blockquote') lineStyle(node.from, node.to, 'cm-lp-quote');
        else if (name === 'QuoteMark') hideSpaced(node.from, node.to);
        else if (name === 'ListMark') {
          if (node.node.parent?.parent?.name === 'BulletList' && !isActive(node.from)) out.push({ kind: 'bullet', from: node.from, to: node.to });
        } else if (name === 'HorizontalRule') {
          lineStyle(node.from, node.to, 'cm-lp-break');
          if (!isActive(node.from)) out.push({ kind: 'break', from: node.from, to: node.to });
        } else if (name === 'Link' && doc.sliceString(node.from - 1, node.from) === '[' && doc.sliceString(node.to, node.to + 1) === ']') {
          // The inner brackets of a wikilink, which wikilinks.js styles.
          return false;
        } else if (name === 'Link') {
          out.push({ kind: 'mark', from: node.from, to: node.to, cls: INLINE.Link });
          const open = node.node.firstChild;
          let close = open?.nextSibling;
          while (close && close.name !== 'LinkMark') close = close.nextSibling;
          if (open && close && !isActive(node.from)) {
            out.push({ kind: 'hide', from: open.from, to: open.to });
            out.push({ kind: 'hide', from: close.from, to: node.to });
          }
          return true;
        } else if (INLINE[name]) out.push({ kind: 'mark', from: node.from, to: node.to, cls: INLINE[name] });
        else if (INLINE_MARKS.has(name)) {
          if (!isActive(node.from)) out.push({ kind: 'hide', from: node.from, to: node.to });
        }
        return true;
      },
    });
  }
  return out.sort((a, b) => a.from - b.from || ORDER[a.kind] - ORDER[b.kind]);
}

class BulletWidget extends WidgetType {
  eq() { return true; }
  toDOM() {
    const span = document.createElement('span');
    span.className = 'cm-lp-bullet';
    span.textContent = '•';
    return span;
  }
}

// A scene break (***, * * *, ---) shown as a centred mark.
class BreakWidget extends WidgetType {
  eq() { return true; }
  toDOM() {
    const span = document.createElement('span');
    span.className = 'cm-lp-scene-break';
    span.setAttribute('aria-label', 'Cambio de escena');
    span.textContent = '⁂';
    return span;
  }
}

const bullet = Decoration.replace({ widget: new BulletWidget() });
const sceneBreak = Decoration.replace({ widget: new BreakWidget() });
const hidden = Decoration.replace({});

function decorations(view) {
  const ranges = previewRanges(view.state, view.visibleRanges).map((r) => {
    if (r.kind === 'line') return Decoration.line({ class: r.cls }).range(r.from);
    if (r.kind === 'mark') return Decoration.mark({ class: r.cls }).range(r.from, r.to);
    if (r.kind === 'bullet') return bullet.range(r.from, r.to);
    if (r.kind === 'break') return sceneBreak.range(r.from, r.to);
    return hidden.range(r.from, r.to);
  });
  return Decoration.set(ranges, true);
}

export const livePreview = ViewPlugin.fromClass(
  class {
    constructor(view) {
      this.decorations = decorations(view);
    }
    update(update) {
      if (update.docChanged || update.viewportChanged || update.selectionSet || syntaxTree(update.startState) !== syntaxTree(update.state)) {
        this.decorations = decorations(update.view);
      }
    }
  },
  { decorations: (plugin) => plugin.decorations },
);
