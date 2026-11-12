/**
 * The manuscript as a reader gets it: pure functions from an ordered outline to Markdown, and a
 * parser for the Markdown the editor supports (used by the .docx writer). No files, no git.
 */
import { displayText } from './wikilink.ts';

export interface ManuscriptScene {
  file: string;
  title?: string;
  text: string;
}

/** A chapter (titled) or the untitled run of scenes before or without chapters. */
export interface ManuscriptPart {
  title?: string;
  scenes: ManuscriptScene[];
}

/** Between two scenes of the same part. Markdown cannot centre it; the .docx writer does. */
export const SCENE_BREAK_MARK = '* * *';

/** What a reader sees of one scene: wikilinks as their shown text, without surrounding blank lines. */
function readerText(scene: ManuscriptScene): string {
  return displayText(scene.text).replace(/^(?:[ \t]*\r?\n)+/, '').trimEnd();
}

/** The parts with the scenes that have something to read; a part left empty keeps its heading only if titled. */
export function readableParts(outline: ManuscriptPart[]): { title?: string; texts: string[] }[] {
  return outline
    .map((part) => ({ title: part.title, texts: part.scenes.map(readerText).filter((text) => text.trim() !== '') }))
    .filter((part) => part.texts.length > 0 || part.title);
}

export function compileMarkdown(title: string, outline: ManuscriptPart[]): string {
  const blocks = [`# ${title}`];
  for (const part of readableParts(outline)) {
    if (part.title) blocks.push(`## ${part.title}`);
    part.texts.forEach((text, i) => {
      if (i > 0) blocks.push(SCENE_BREAK_MARK);
      blocks.push(text);
    });
  }
  return `${blocks.join('\n\n')}\n`;
}

// ---- The Markdown subset (headings, paragraphs, emphasis, lists, quotes, breaks) ----

export interface Run {
  text?: string;
  bold?: boolean;
  italic?: boolean;
  strike?: boolean;
  /** A hard line break (two trailing spaces or a backslash). */
  br?: boolean;
}

export type Block =
  | { kind: 'heading'; level: number; runs: Run[] }
  | { kind: 'paragraph'; runs: Run[] }
  | { kind: 'quote'; runs: Run[] }
  | { kind: 'list'; ordered: boolean; level: number; runs: Run[]; index: number; listId: number }
  | { kind: 'break' };

const HEADING = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$/;
const THEMATIC = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
const QUOTE = /^ {0,3}> ?/;
const LIST_ITEM = /^(\s*)([-+*]|\d{1,9}[.)])[ \t]+(.*)$/;
const FENCE = /^ {0,3}(```|~~~)/;
const PUNCT = /[\\`*_{}[\]()#+\-.!~>|<]/;

function isWordChar(ch: string | undefined): boolean {
  return ch !== undefined && /[\p{L}\p{N}]/u.test(ch);
}

function push(runs: Run[], text: string, style: Run): void {
  if (!text) return;
  const last = runs[runs.length - 1];
  if (last && last.text !== undefined && !!last.bold === !!style.bold && !!last.italic === !!style.italic && !!last.strike === !!style.strike) {
    last.text += text;
  } else {
    runs.push({ text, ...(style.bold ? { bold: true } : {}), ...(style.italic ? { italic: true } : {}), ...(style.strike ? { strike: true } : {}) });
  }
}

/** Inline emphasis, strikethrough, escapes, code spans and links. Anything that is not understood stays as plain text. */
export function parseInline(src: string, style: Run = {}, runs: Run[] = []): Run[] {
  let i = 0;
  let plain = '';
  const flush = () => {
    push(runs, plain, style);
    plain = '';
  };
  while (i < src.length) {
    const ch = src[i];
    if (ch === '\\' && i + 1 < src.length && PUNCT.test(src[i + 1])) {
      plain += src[i + 1];
      i += 2;
      continue;
    }
    if (ch === '`') {
      const ticks = /^`+/.exec(src.slice(i))![0];
      const close = src.indexOf(ticks, i + ticks.length);
      if (close > i + ticks.length - 1 && close !== -1) {
        plain += src.slice(i + ticks.length, close);
        i = close + ticks.length;
        continue;
      }
      plain += ticks;
      i += ticks.length;
      continue;
    }
    if (ch === '[' || (ch === '!' && src[i + 1] === '[')) {
      const image = ch === '!';
      const start = image ? i + 1 : i;
      const m = /^\[([^\]]*)\]\(([^)\s]*)(?:\s+"[^"]*")?\)/.exec(src.slice(start));
      if (m) {
        flush();
        parseInline(m[1] || (image ? m[2] : ''), style, runs);
        if (m[2] && m[1] && m[1] !== m[2]) push(runs, ` (${m[2]})`, style);
        i = start + m[0].length;
        continue;
      }
    }
    if (ch === '*' || ch === '_' || ch === '~') {
      const run = /^(?:\*+|_+|~+)/.exec(src.slice(i))![0];
      const size = Math.min(run.length, ch === '~' ? 2 : 3);
      const opens = (ch !== '~' || size === 2) && !/\s/.test(src[i + run.length] ?? ' ')
        && !(ch === '_' && isWordChar(src[i - 1]));
      if (opens) {
        const delim = ch.repeat(size);
        let close = -1;
        for (let j = i + run.length; j < src.length; j++) {
          if (src[j] === '\\') { j++; continue; }
          if (src.startsWith(delim, j) && !/\s/.test(src[j - 1] ?? ' ') && !(ch === '_' && isWordChar(src[j + size]))) {
            close = j;
            break;
          }
        }
        if (close > i + run.length - 1) {
          flush();
          const extra = run.length - size;
          const inner = ch.repeat(extra) + src.slice(i + run.length, close);
          const next: Run = ch === '~'
            ? { ...style, strike: true }
            : { ...style, ...(size >= 2 ? { bold: true } : {}), ...(size === 1 || size === 3 ? { italic: true } : {}) };
          parseInline(inner, next, runs);
          i = close + size;
          continue;
        }
      }
      plain += run;
      i += run.length;
      continue;
    }
    plain += ch;
    i += 1;
  }
  flush();
  return runs;
}

/** Joins the lines of one paragraph: a soft newline is a space, a hard break (two spaces or a backslash) is a break run. */
function paragraphRuns(lines: string[]): Run[] {
  const runs: Run[] = [];
  lines.forEach((raw, n) => {
    const hard = n < lines.length - 1 && (/ {2,}$/.test(raw) || /\\$/.test(raw));
    const line = (hard && raw.endsWith('\\') ? raw.slice(0, -1) : raw).trim();
    const part = parseInline(line);
    if (n > 0 && !(runs[runs.length - 1]?.br)) push(runs, ' ', {});
    for (const run of part) {
      if (run.text !== undefined && !run.bold && !run.italic && !run.strike) push(runs, run.text, {});
      else runs.push(run);
    }
    if (hard) runs.push({ br: true });
  });
  return runs;
}

let listCounter = 0;

/** Parses the Markdown subset the editor supports into blocks. Unsupported syntax stays as plain paragraph text. */
export function parseMarkdown(markdown: string): Block[] {
  const lines = markdown.replace(/\r\n?/g, '\n').split('\n');
  const blocks: Block[] = [];
  let para: string[] = [];
  let list: { ordered: boolean; id: number; count: number } | null = null;
  const flush = () => {
    if (para.length) blocks.push({ kind: 'paragraph', runs: paragraphRuns(para) });
    para = [];
  };
  for (let n = 0; n < lines.length; n++) {
    const line = lines[n];
    const fence = FENCE.exec(line);
    if (fence) {
      flush();
      list = null;
      for (n++; n < lines.length && !lines[n].trimStart().startsWith(fence[1]); n++) {
        blocks.push({ kind: 'paragraph', runs: lines[n] ? [{ text: lines[n] }] : [] });
      }
      continue;
    }
    if (line.trim() === '') {
      flush();
      list = null;
      continue;
    }
    const heading = HEADING.exec(line);
    if (heading) {
      flush();
      list = null;
      blocks.push({ kind: 'heading', level: heading[1].length, runs: parseInline(heading[2] ?? '') });
      continue;
    }
    if (THEMATIC.test(line)) {
      flush();
      list = null;
      blocks.push({ kind: 'break' });
      continue;
    }
    if (QUOTE.test(line)) {
      flush();
      list = null;
      const inner: string[] = [];
      for (; n < lines.length && QUOTE.test(lines[n]); n++) inner.push(lines[n].replace(QUOTE, ''));
      n--;
      for (const sub of parseMarkdown(inner.join('\n'))) {
        if (sub.kind === 'break') blocks.push(sub);
        else blocks.push({ kind: 'quote', runs: 'runs' in sub ? sub.runs : [] });
      }
      continue;
    }
    const item = LIST_ITEM.exec(line);
    if (item) {
      flush();
      const ordered = /\d/.test(item[2]);
      const level = Math.min(2, Math.floor(item[1].replace(/\t/g, '    ').length / 2));
      if (!list || list.ordered !== ordered) list = { ordered, id: ++listCounter, count: 0 };
      list.count++;
      blocks.push({ kind: 'list', ordered, level, runs: parseInline(item[3]), index: list.count, listId: list.id });
      continue;
    }
    const last = blocks[blocks.length - 1];
    if (list && last?.kind === 'list' && /^\s+/.test(line) && para.length === 0) {
      // A continuation line of the previous item.
      last.runs.push(...paragraphRuns([' ' + line.trim()]));
      continue;
    }
    list = null;
    para.push(line);
  }
  flush();
  return blocks;
}
