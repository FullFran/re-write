/**
 * Book notes: one Markdown file per character, place, object or plot thread, in `notas/`. Pure: no
 * files, no git. A note's name is its file name without `.md`, which is also what a wikilink names.
 */

export const NOTES_DIR = 'notas';
export const NOTE_TYPES = ['personaje', 'lugar', 'objeto', 'trama', 'otra'] as const;
export type NoteType = (typeof NOTE_TYPES)[number];

/**
 * Characters a reader cannot see, which would make two names look the same: format characters
 * (zero-width, direction overrides, soft hyphen, BOM), private-use and unassigned code points,
 * line and paragraph separators, and other default-ignorable characters (grapheme joiner, Hangul
 * fillers, variation selectors).
 */
const INVISIBLE = /[\p{Cf}\p{Co}\p{Cn}\p{Zl}\p{Zp}͏ᅟᅠ឴឵᠋-᠏ㅤ︀-️ﾠ\u{E0100}-\u{E01EF}]/u;

/**
 * Why a name cannot be a note, or null when it can. Refused: empty or padded names, a leading dot
 * (hidden files), a final dot or two dots in a row, path separators and ':' (not portable), control
 * and invisible characters, whitespace other than a plain space, the characters that end or split a
 * wikilink (`[ ] | # ^`), and names whose file would exceed 255 bytes.
 */
export function checkNoteName(name: string): string | null {
  if (!name.trim()) return 'a note name cannot be empty';
  if (name !== name.trim()) return 'a note name cannot start or end with spaces';
  if (name.startsWith('.')) return 'a note name cannot start with a dot';
  if (/\p{Cc}/u.test(name)) return 'a note name cannot contain control characters';
  if (INVISIBLE.test(name)) return 'a note name cannot contain invisible characters (zero-width, direction marks and similar)';
  if (/(?! )\s/u.test(name)) return 'a note name cannot contain spaces other than a plain space';
  for (const char of ['/', '\\', ':', '[', ']', '|', '#', '^']) {
    if (name.includes(char)) return `a note name cannot contain "${char}"`;
  }
  // A file name with ".." or a final "." does not survive the path checks a revision makes.
  if (name.includes('..') || name.endsWith('.')) return 'a note name cannot end with a dot or contain two dots in a row';
  if (!name.isWellFormed()) return 'a note name is not valid Unicode';
  if (Buffer.byteLength(`${name}.md`, 'utf8') > 255) return 'a note file name cannot exceed 255 bytes';
  return null;
}

export interface Frontmatter {
  type: string | null;
  aliases: string[];
  /** Supported keys that could not be read, in words for the person; the note is still usable. */
  problems: string[];
  /** Where the body starts: after the closing `---` line, or 0 when there is no frontmatter. */
  body_start: number;
}

const LIST_PROBLEM = 'aliases must be a list like [a, b] or lines starting with "- "';

/**
 * Reads the leading `---` block of a note for the keys RE;write uses: `type` (one of NOTE_TYPES) and
 * `aliases` (a flow list `[a, "b, c"]` or lines `- a`). It is a strict reader of that subset, not a
 * YAML parser: every other key, and its indented lines, is skipped and never rewritten.
 */
export function parseFrontmatter(text: string): Frontmatter {
  const none: Frontmatter = { type: null, aliases: [], problems: [], body_start: 0 };
  // A byte order mark some editors write is skipped, never a reason to ignore the frontmatter.
  const first = /^\uFEFF?---\r?\n/.exec(text);
  if (!first) return none;
  const lines: { text: string; end: number }[] = [];
  let at = first[0].length;
  let close = -1;
  while (at < text.length) {
    const newline = text.indexOf('\n', at);
    const end = newline === -1 ? text.length : newline + 1;
    const line = text.slice(at, end).replace(/\r?\n$/, '');
    if (line === '---' || line === '...') { close = end; break; }
    lines.push({ text: line, end });
    at = end;
  }
  if (close === -1) return { ...none, problems: ['the frontmatter opened by "---" is never closed'] };

  const result: Frontmatter = { type: null, aliases: [], problems: [], body_start: close };
  const seen = new Set<string>();
  for (let i = 0; i < lines.length; i += 1) {
    const key = /^([A-Za-z_][\w-]*):(.*)$/.exec(lines[i].text);
    if (!key || (key[1] !== 'type' && key[1] !== 'aliases')) continue;
    const name = key[1];
    if (seen.has(name)) { result.problems.push(`${name} appears more than once`); continue; }
    seen.add(name);
    const value = key[2].trim();
    if (name === 'type') {
      const type = unquote(value);
      if (type !== null && (NOTE_TYPES as readonly string[]).includes(type)) result.type = type;
      else result.problems.push(`type must be one of ${NOTE_TYPES.join(', ')}; found "${value}"`);
      continue;
    }
    let items: (string | null)[] | null;
    if (value === '') {
      items = [];
      while (i + 1 < lines.length && /^\s*-(\s|$)/.test(lines[i + 1].text)) {
        i += 1;
        items.push(unquote(lines[i].text.trim().slice(1).trim()));
      }
      if (!items.length) items = null;
    } else {
      items = flowList(value);
    }
    if (items === null || items.some((item) => item === null)) result.problems.push(LIST_PROBLEM);
    else if (items.some((item) => item === '')) result.problems.push('aliases cannot hold an empty name');
    else result.aliases = items as string[];
  }
  return result;
}

/** A scalar, without its quotes when it has matching ones; null when the quoting is broken. */
function unquote(value: string): string | null {
  const quote = value[0];
  if (quote === '"' || quote === "'") {
    if (value.length < 2 || value[value.length - 1] !== quote) return null;
    const inner = value.slice(1, -1);
    return inner.includes(quote) ? null : inner;
  }
  if (/^["'[\]{}]/.test(value) || /[[\]{}]/.test(value)) return null;
  return value;
}

/** `[a, "b, c", 'd']` as its items, or null when it is not such a list. */
function flowList(value: string): (string | null)[] | null {
  if (!value.startsWith('[') || !value.endsWith(']')) return null;
  const inner = value.slice(1, -1).trim();
  if (!inner) return [];
  const items: (string | null)[] = [];
  let i = 0;
  while (i <= inner.length) {
    while (inner[i] === ' ') i += 1;
    let end: number;
    if (inner[i] === '"' || inner[i] === "'") {
      const close = inner.indexOf(inner[i], i + 1);
      if (close === -1) return null;
      end = close + 1;
      const rest = inner.slice(end).trimStart();
      if (rest && !rest.startsWith(',')) return null;
    } else {
      end = inner.indexOf(',', i);
      if (end === -1) end = inner.length;
    }
    items.push(unquote(inner.slice(i, end).trim()));
    const comma = inner.indexOf(',', end);
    if (comma === -1) break;
    i = comma + 1;
  }
  return items;
}
