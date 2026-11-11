// The "Lectura" view: the scene rendered as elements built from the Markdown syntax tree.
// Scene text only ever becomes text nodes; nothing in it is parsed as HTML, and links keep
// their words but never become links.
import { parser } from './markdown.js';
import { wikilinksIn } from './wikilinks.js';

// Syntax that is not shown when the text is read.
const MARKS = new Set(['HeaderMark', 'EmphasisMark', 'QuoteMark', 'ListMark', 'CodeMark', 'LinkMark', 'URL', 'LinkTitle', 'LinkLabel', 'StrikethroughMark', 'CodeInfo']);
// After these marks the one space that separates them from the text is syntax too.
const SPACED = new Set(['HeaderMark', 'QuoteMark', 'ListMark']);
const INLINE = { Emphasis: 'em', StrongEmphasis: 'strong', Strikethrough: 's', InlineCode: 'code' };

// A link or an image shows only its words, the part between its brackets.
function linkWords(node) {
  const open = node.firstChild;
  let close = open && open.nextSibling;
  while (close && close.name !== 'LinkMark') close = close.nextSibling;
  return open && close ? { from: open.to, to: close.from } : null;
}

function inline(node, text, range = { from: node.from, to: node.to }) {
  const out = [];
  let pos = range.from;
  const push = (value) => {
    if (!value) return;
    if (typeof out[out.length - 1] === 'string') out[out.length - 1] += value;
    else out.push(value);
  };
  for (let child = node.firstChild; child; child = child.nextSibling) {
    if (child.from < range.from) continue;
    if (child.from >= range.to) break;
    push(text.slice(pos, child.from));
    pos = child.to;
    const name = child.name;
    if (MARKS.has(name)) {
      if (SPACED.has(name) && text[pos] === ' ') pos += 1;
    } else if (name === 'HardBreak') {
      out.push({ tag: 'br', children: [] });
    } else if (name === 'Escape') {
      push(text.slice(child.from + 1, child.to));
    } else if (name === 'Image' && text.startsWith('![[', child.from) && text.startsWith(']]', child.to - 2)) {
      // An embed ![[...]] is not a link (as on the server): it stays as written.
      push(text.slice(child.from, child.to));
    } else if (name === 'Link' && text[child.from - 1] === '[' && text[child.to] === ']' && wikilinksIn(text.slice(child.from - 1, child.to + 1), 0).length) {
      // A wikilink: lezer reads its inner brackets as a link; the reader sees the link's text.
      const link = wikilinksIn(text.slice(child.from - 1, child.to + 1), child.from - 1)[0];
      const last = out[out.length - 1];
      if (typeof last === 'string') out[out.length - 1] = last.slice(0, -1);
      if (out[out.length - 1] === '') out.pop();
      out.push({ tag: 'span', children: [text.slice(link.shownFrom, link.shownTo)] });
      pos = child.to + 1;
    } else if (name === 'Link' || name === 'Image') {
      const words = linkWords(child);
      out.push({ tag: 'span', children: words ? inline(child, text, words) : [text.slice(child.from, child.to)] });
    } else if (INLINE[name]) {
      out.push({ tag: INLINE[name], children: inline(child, text) });
    } else {
      push(text.slice(child.from, child.to));
    }
  }
  push(text.slice(pos, range.to));
  return out;
}

function trimmed(children) {
  if (typeof children[0] === 'string') children[0] = children[0].replace(/^\s+/, '');
  const last = children.length - 1;
  if (typeof children[last] === 'string') children[last] = children[last].replace(/\s+$/, '');
  return children.filter((child) => child !== '');
}

function block(node, text) {
  const name = node.name;
  const heading = /^(?:ATX|Setext)Heading(\d)$/.exec(name);
  if (heading) return { tag: 'h' + heading[1], children: trimmed(inline(node, text)) };
  if (name === 'Paragraph') return { tag: 'p', children: trimmed(inline(node, text)) };
  if (name === 'Blockquote') return { tag: 'blockquote', children: blocks(node, text) };
  if (name === 'BulletList') return { tag: 'ul', children: blocks(node, text) };
  if (name === 'OrderedList') return { tag: 'ol', children: blocks(node, text) };
  if (name === 'ListItem') return { tag: 'li', children: blocks(node, text) };
  if (name === 'HorizontalRule') return { tag: 'hr', children: [] };
  if (name === 'FencedCode') {
    const code = node.getChild('CodeText');
    return { tag: 'pre', children: [code ? text.slice(code.from, code.to) : ''] };
  }
  if (name === 'CodeBlock') return { tag: 'pre', children: [text.slice(node.from, node.to)] };
  if (MARKS.has(name)) return null;
  // HTML, link reference definitions and anything else: shown as the text it is.
  return { tag: 'p', children: [text.slice(node.from, node.to)] };
}

function blocks(node, text) {
  const out = [];
  for (let child = node.firstChild; child; child = child.nextSibling) {
    const built = block(child, text);
    if (built) out.push(built);
  }
  return out;
}

/** The scene as a tree of { tag, children } where every leaf is a string. */
export function readingTree(text) {
  return blocks(parser.parse(text).topNode, text);
}

function toDom(node, doc) {
  if (typeof node === 'string') return doc.createTextNode(node);
  const element = doc.createElement(node.tag);
  for (const child of node.children) element.append(toDom(child, doc));
  return element;
}

/** Fills `target` with the scene rendered for reading. */
export function renderReading(target, text) {
  const doc = target.ownerDocument;
  target.replaceChildren(...readingTree(text).map((node) => toDom(node, doc)));
}
