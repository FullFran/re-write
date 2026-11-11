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

const WHITESPACE = /\s/u;

/**
 * The folded form of a whole text, with the original index of every folded character, so a match
 * found in the folded text maps back to the original. Whitespace runs fold to one space. One pass;
 * ASCII takes a fast path.
 */
export function foldWithMap(text: string): { folded: string; at: number[] } {
  const parts: string[] = [];
  const at: number[] = [];
  let index = 0;
  let lastSpace = false;
  for (const char of text) {
    const code = char.charCodeAt(0);
    const space = code < 128 ? code === 32 || (code >= 9 && code <= 13) : WHITESPACE.test(char);
    if (space) {
      if (!lastSpace) { parts.push(' '); at.push(index); }
      lastSpace = true;
    } else {
      const out = code < 128 ? (code >= 65 && code <= 90 ? String.fromCharCode(code + 32) : char) : foldChars(char);
      for (let k = 0; k < out.length; k += 1) at.push(index);
      parts.push(out);
      lastSpace = false;
    }
    index += char.length;
  }
  at.push(text.length);
  return { folded: parts.join(''), at };
}

/** The index where each line starts (after each `\n`), for positions by binary search. */
export function lineStartsOf(text: string): number[] {
  const starts = [0];
  for (let i = text.indexOf('\n'); i !== -1; i = text.indexOf('\n', i + 1)) starts.push(i + 1);
  return starts;
}

/** 1-based line and column of an index, given lineStartsOf(text). */
export function positionAt(starts: number[], index: number): { line: number; column: number } {
  let low = 0;
  let high = starts.length - 1;
  while (low < high) {
    const mid = (low + high + 1) >> 1;
    if (starts[mid] <= index) low = mid; else high = mid - 1;
  }
  return { line: low + 1, column: index - starts[low] + 1 };
}

/**
 * Ranges `[start, end)` of fenced code blocks (``` or ~~~, closed by a fence of the same character at
 * least as long, or by the end of the text) and of code spans outside them, in text order. Linear:
 * one pass over the lines for fences, one over the characters for backtick runs, and each run is
 * paired with the next run of the same length in the same stretch between fences.
 */
export function codeRanges(text: string): [number, number][] {
  const fenced: [number, number][] = [];
  let fence: { char: string; size: number; start: number } | null = null;
  let lineStart = 0;
  while (lineStart <= text.length) {
    const newline = text.indexOf('\n', lineStart);
    const lineEnd = newline === -1 ? text.length : newline + 1;
    const marker = fenceMarker(text, lineStart, newline === -1 ? text.length : newline);
    if (fence === null) {
      if (marker && !(marker.char === '`' && marker.info.includes('`'))) fence = { char: marker.char, size: marker.size, start: lineStart };
    } else if (marker && marker.char === fence.char && marker.size >= fence.size && marker.info.trim() === '') {
      fenced.push([fence.start, lineEnd]);
      fence = null;
    }
    if (newline === -1) break;
    lineStart = lineEnd;
  }
  if (fence !== null) fenced.push([fence.start, text.length]);

  // Backtick runs outside fences, each tagged with the stretch (between fences) it lies in.
  const runs: { at: number; size: number; stretch: number }[] = [];
  let f = 0;
  for (let i = 0; i < text.length;) {
    if (f < fenced.length && i >= fenced[f][0]) { i = fenced[f][1]; f += 1; continue; }
    if (text.charCodeAt(i) !== 96) { i += 1; continue; }
    let size = 0;
    while (text.charCodeAt(i + size) === 96) size += 1;
    const limit = f < fenced.length ? fenced[f][0] : text.length;
    // A run cut by the next fence still counts only up to it.
    runs.push({ at: i, size: Math.min(size, limit - i), stretch: f });
    i += size;
  }
  const next = new Array<number>(runs.length).fill(-1);
  const last = new Map<string, number>();
  for (let r = runs.length - 1; r >= 0; r -= 1) {
    const key = `${runs[r].stretch}:${runs[r].size}`;
    next[r] = last.get(key) ?? -1;
    last.set(key, r);
  }
  const spans: [number, number][] = [];
  let covered = 0;
  for (let r = 0; r < runs.length; r += 1) {
    if (runs[r].at < covered || next[r] === -1) continue;
    const close = runs[next[r]];
    spans.push([runs[r].at, close.at + close.size]);
    covered = close.at + close.size;
  }
  const all: [number, number][] = [];
  for (let a = 0, b = 0; a < fenced.length || b < spans.length;) {
    if (b >= spans.length || (a < fenced.length && fenced[a][0] < spans[b][0])) all.push(fenced[a++]);
    else all.push(spans[b++]);
  }
  return all;
}

/** A fence line: up to three spaces, then three or more ` or ~, then its info string. */
function fenceMarker(text: string, start: number, end: number): { char: string; size: number; info: string } | null {
  let i = start;
  while (i < end && i - start < 3 && text[i] === ' ') i += 1;
  const char = text[i];
  if (char !== '`' && char !== '~') return null;
  let size = 0;
  while (i + size < end && text[i + size] === char) size += 1;
  if (size < 3) return null;
  return { char, size, info: text.slice(i + size, end).replace(/\r$/, '') };
}

/**
 * Every wikilink outside code, in text order. One forward scan: from each `[[` the inner text is
 * read up to the first `[`, `]` or line break, and the scan resumes there, so no character is read
 * more than a few times.
 */
export function parseWikilinks(text: string): Wikilink[] {
  const code = codeRanges(text);
  const starts = lineStartsOf(text);
  const links: Wikilink[] = [];
  let c = 0;
  let i = 0;
  while ((i = text.indexOf('[[', i)) !== -1) {
    while (c < code.length && code[c][1] <= i) c += 1;
    if (c < code.length && code[c][0] <= i) { i = code[c][1]; continue; }
    let j = i + 2;
    while (j < text.length) {
      const ch = text.charCodeAt(j);
      if (ch === 91 || ch === 93 || ch === 10 || ch === 13) break;
      j += 1;
    }
    if (text.charCodeAt(j) !== 93 || text.charCodeAt(j + 1) !== 93) { i = j > i + 2 ? j : i + 1; continue; }
    const end = j + 2;
    const embed = i > 0 && text[i - 1] === '!';
    const link = embed ? null : readInner(text.slice(i + 2, j));
    if (link) links.push({ ...link, raw: text.slice(i, end), start: i, end, ...positionAt(starts, i) });
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
