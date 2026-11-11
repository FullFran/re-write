/**
 * Wikilinks in Obsidian's form, in notes and in scene prose. Pure: no files, no git.
 *
 * Supported: `[[Nota]]`, `[[Nota|texto]]`, `[[Nota#Sección]]` and `[[Nota#Sección|texto]]`.
 * Skipped without breaking the rest of the text: embeds (`![[...]]`), block references
 * (`[[Nota#^id]]`), empty targets, and anything inside a code span or a fenced code block.
 * A link never spans lines and its inner text never holds `[` or `]`.
 */

export interface Wikilink {
  /** The note name as written, trimmed. */
  target: string;
  section: string | null;
  label: string | null;
  /** What a reader sees: the label when there is one, otherwise the target. */
  shown: string;
  /** The link as written, `text.slice(start, end)`. */
  raw: string;
  start: number;
  end: number;
  /** 1-based line, and 1-based column in UTF-16 code units (the editor's own unit). */
  line: number;
  column: number;
}

/**
 * The key two names are compared by: Unicode NFD, combining marks removed, lower case, runs of
 * whitespace collapsed to one space, trimmed. No transliteration ("ß" stays "ß").
 */
export function foldName(name: string): string {
  return foldChars(name).replace(/\s+/gu, ' ').trim();
}

function foldChars(text: string): string {
  return text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
}

/**
 * The folded form of a whole text, with the original index of every folded character, so a match
 * found in the folded text maps back to the original. Whitespace runs fold to one space.
 */
export function foldWithMap(text: string): { folded: string; at: number[] } {
  let folded = '';
  const at: number[] = [];
  let index = 0;
  let lastSpace = false;
  for (const char of text) {
    if (/\s/u.test(char)) {
      if (!lastSpace) { folded += ' '; at.push(index); }
      lastSpace = true;
    } else {
      for (const out of foldChars(char)) { folded += out; at.push(index); }
      lastSpace = false;
    }
    index += char.length;
  }
  at.push(text.length);
  return { folded, at };
}

/**
 * Ranges `[start, end)` of fenced code blocks (``` or ~~~, closed by a fence of the same character at
 * least as long, or by the end of the text) and of code spans outside them.
 */
export function codeRanges(text: string): [number, number][] {
  const ranges: [number, number][] = [];
  const fenced: [number, number][] = [];
  let fence: { char: string; size: number; start: number } | null = null;
  let lineStart = 0;
  while (lineStart <= text.length) {
    const newline = text.indexOf('\n', lineStart);
    const lineEnd = newline === -1 ? text.length : newline + 1;
    const line = text.slice(lineStart, lineEnd).replace(/\r?\n$/, '');
    const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (fence === null) {
      if (marker && !(marker[1][0] === '`' && marker[2].includes('`'))) fence = { char: marker[1][0], size: marker[1].length, start: lineStart };
    } else if (marker && marker[1][0] === fence.char && marker[1].length >= fence.size && marker[2].trim() === '') {
      fenced.push([fence.start, lineEnd]);
      fence = null;
    }
    if (newline === -1) break;
    lineStart = lineEnd;
  }
  if (fence !== null) fenced.push([fence.start, text.length]);

  const fenceAt = (i: number) => fenced.find(([s, e]) => i >= s && i < e);
  let i = 0;
  while (i < text.length) {
    const inFence = fenceAt(i);
    if (inFence) { i = inFence[1]; continue; }
    if (text[i] !== '`') { i += 1; continue; }
    let size = 0;
    while (text[i + size] === '`') size += 1;
    // The closing run has exactly the same length and lies before the next fence.
    const limit = fenced.find(([s]) => s > i)?.[0] ?? text.length;
    let close = -1;
    for (let j = i + size; j < limit;) {
      if (text[j] !== '`') { j += 1; continue; }
      let run = 0;
      while (text[j + run] === '`') run += 1;
      if (run === size && j + run <= limit) { close = j; break; }
      j += run;
    }
    if (close === -1) { i += size; continue; }
    ranges.push([i, close + size]);
    i = close + size;
  }
  return [...fenced, ...ranges].sort((a, b) => a[0] - b[0]);
}

/** Every wikilink outside code, in text order. */
export function parseWikilinks(text: string): Wikilink[] {
  const code = codeRanges(text);
  const lineStarts = [0];
  for (let i = text.indexOf('\n'); i !== -1; i = text.indexOf('\n', i + 1)) lineStarts.push(i + 1);
  const links: Wikilink[] = [];
  let i = 0;
  while ((i = text.indexOf('[[', i)) !== -1) {
    const inCode = code.find(([s, e]) => i >= s && i < e);
    if (inCode) { i = inCode[1]; continue; }
    const close = text.indexOf(']]', i + 2);
    const inner = close === -1 ? null : text.slice(i + 2, close);
    if (inner === null || /[[\]\r\n]/.test(inner)) { i += 1; continue; }
    const end = close + 2;
    const embed = i > 0 && text[i - 1] === '!';
    const link = embed ? null : readInner(inner);
    if (link) {
      let line = 0;
      while (line + 1 < lineStarts.length && lineStarts[line + 1] <= i) line += 1;
      links.push({ ...link, raw: text.slice(i, end), start: i, end, line: line + 1, column: i - lineStarts[line] + 1 });
    }
    i = end;
  }
  return links;
}

function readInner(inner: string): Pick<Wikilink, 'target' | 'section' | 'label' | 'shown'> | null {
  const bar = inner.indexOf('|');
  const left = bar === -1 ? inner : inner.slice(0, bar);
  const label = bar === -1 ? null : inner.slice(bar + 1).trim() || null;
  const hash = left.indexOf('#');
  const target = (hash === -1 ? left : left.slice(0, hash)).trim();
  const section = hash === -1 ? null : left.slice(hash + 1).trim() || null;
  if (!target || section?.startsWith('^')) return null;
  return { target, section, label, shown: label ?? target };
}

/**
 * The text a reader sees, for exports: each link becomes its shown text (`[[Elena|la capitana]]`
 * -> `la capitana`, `[[Elena]]` -> `Elena`, `[[Sal#Puerto]]` -> `Sal`). Code, embeds and every other
 * character stay exactly as they are.
 */
export function displayText(text: string): string {
  let out = '';
  let from = 0;
  for (const link of parseWikilinks(text)) {
    out += text.slice(from, link.start) + link.shown;
    from = link.end;
  }
  return out + text.slice(from);
}
