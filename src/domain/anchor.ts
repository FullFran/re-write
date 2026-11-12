/** Literal anchors into a text. Pure: callers supply the text. */

export type EvidenceStatus = 'valid' | 'stale' | 'orphaned';

export interface Anchor {
  quote: string;
  prefix: string;
  suffix: string;
  start: number;
}

export interface EvidenceAssessment {
  status: EvidenceStatus;
  reason: string;
  current_start?: number;
}

const CONTEXT_LENGTH = 32;

function occurrences(text: string, quote: string): number[] {
  const found: number[] = [];
  for (let at = text.indexOf(quote); at !== -1; at = text.indexOf(quote, at + 1)) found.push(at);
  return found;
}

/** Builds an anchor, refusing quotes that are absent or ambiguous. */
export function buildAnchor(text: string, quote: string): Anchor {
  if (!quote) throw new Error('quote is empty');
  const found = occurrences(text, quote);
  if (found.length === 0) throw new Error('quote not found in the scene at this revision');
  if (found.length > 1) throw new Error(`quote appears ${found.length} times; use a longer quote`);
  const start = found[0];
  return {
    quote,
    prefix: text.slice(Math.max(0, start - CONTEXT_LENGTH), start),
    suffix: text.slice(start + quote.length, start + quote.length + CONTEXT_LENGTH),
    start,
  };
}

/** True when the anchor literally matches the text of its recorded revision. */
export function matchesRevision(anchor: Anchor, revisionText: string): boolean {
  return revisionText.slice(anchor.start, anchor.start + anchor.quote.length) === anchor.quote;
}

/**
 * Compares an anchor with the current text. A quote that survives with its
 * context is valid, even if it moved. If the words around it changed, its
 * meaning may have changed too, so it is stale. If it is gone, it is orphaned.
 */
export function assessAnchor(anchor: Anchor, currentText: string | null): EvidenceAssessment {
  if (currentText === null) return { status: 'orphaned', reason: 'file_missing' };
  const found = occurrences(currentText, anchor.quote);
  if (found.length === 0) return { status: 'orphaned', reason: 'quote_not_found' };
  const inContext = found.filter((at) =>
    currentText.slice(Math.max(0, at - anchor.prefix.length), at) === anchor.prefix &&
    currentText.slice(at + anchor.quote.length, at + anchor.quote.length + anchor.suffix.length) === anchor.suffix);
  if (inContext.length === 1) {
    const at = inContext[0];
    return { status: 'valid', reason: at === anchor.start ? 'unchanged' : 'relocated', current_start: at };
  }
  return { status: 'stale', reason: found.length > 1 ? 'ambiguous' : 'context_changed', current_start: found[0] };
}

/** How a suggestion was found: the literal quote at a new place, or the closest passage by shared words. */
export type SuggestionKind = 'moved' | 'similar';

export interface AnchorSuggestion {
  quote: string;
  start: number;
  how: SuggestionKind;
}

/** The work cap: a text longer than this, in UTF-16 code units, is not searched for a new anchor. */
export const MAX_SUGGESTION_CHARS = 1_048_576;

/** The least share of the old quote's word weight a passage must repeat to be suggested. */
export const MIN_SIMILARITY = 0.5;

const WORD = /[\p{L}\p{N}]+/gu;

function countUpTo(text: string, quote: string, limit: number): number {
  let count = 0;
  for (let at = text.indexOf(quote); at !== -1 && count < limit; at = text.indexOf(quote, at + 1)) count++;
  return count;
}

/** How many characters of the old prefix (from its end) and suffix (from its start) still surround `at`. */
function contextScore(anchor: Anchor, text: string, at: number): number {
  let score = 0;
  for (let i = 1; i <= anchor.prefix.length && text[at - i] === anchor.prefix[anchor.prefix.length - i]; i++) score++;
  const after = at + anchor.quote.length;
  for (let i = 0; i < anchor.suffix.length && text[after + i] === anchor.suffix[i]; i++) score++;
  return score;
}

/** Widens [from, to) a word at a time on each side, up to CONTEXT_LENGTH beyond it, until it appears once. */
function widenUntilUnique(text: string, from: number, to: number): [number, number] | null {
  const minFrom = Math.max(0, from - CONTEXT_LENGTH);
  const maxTo = Math.min(text.length, to + CONTEXT_LENGTH);
  const isWord = (c: string | undefined) => c !== undefined && /[\p{L}\p{N}]/u.test(c);
  while (countUpTo(text, text.slice(from, to), 2) > 1) {
    if (from <= minFrom && to >= maxTo) return null;
    if (from > minFrom) {
      do from--; while (from > minFrom && !isWord(text[from]));
      while (from > minFrom && isWord(text[from - 1])) from--;
    }
    if (to < maxTo) {
      do to++; while (to < maxTo && !isWord(text[to - 1]));
      while (to < maxTo && isWord(text[to])) to++;
    }
  }
  return [from, to];
}

/**
 * The passage of the current text that a stale or orphaned anchor most likely meant now, or null when
 * there is none (the quote was removed). The result is always literal and unique in `text`, so a person
 * can accept it as a new anchor with buildAnchor. Linear in the length of the text, at most
 * MAX_SUGGESTION_CHARS of it:
 * - the literal quote, once: that position (it moved, or the words around it changed);
 * - the literal quote, several times: the copy whose old context survives best, widened word by word
 *   until it is unique (at most CONTEXT_LENGTH more on each side);
 * - the quote is gone: the run of as many words as the quote has that repeats the largest share of its
 *   words, each weighted by its length so short function words count little; at least MIN_SIMILARITY of
 *   the weight, ties going to the run nearest the old position.
 */
export function suggestAnchor(anchor: Anchor, text: string | null): AnchorSuggestion | null {
  if (text === null || text.length > MAX_SUGGESTION_CHARS || !anchor.quote) return null;
  const found = occurrences(text, anchor.quote);
  if (found.length === 1) return { quote: anchor.quote, start: found[0], how: 'moved' };
  if (found.length > 1) {
    let best = found[0];
    let bestScore = -1;
    for (const at of found) {
      const score = contextScore(anchor, text, at);
      if (score > bestScore || (score === bestScore && Math.abs(at - anchor.start) < Math.abs(best - anchor.start))) {
        best = at;
        bestScore = score;
      }
    }
    const span = widenUntilUnique(text, best, best + anchor.quote.length);
    return span ? { quote: text.slice(span[0], span[1]), start: span[0], how: 'moved' } : null;
  }
  return similarPassage(anchor, text);
}

function similarPassage(anchor: Anchor, text: string): AnchorSuggestion | null {
  const need = new Map<string, number>();
  let total = 0;
  for (const [word] of anchor.quote.matchAll(WORD)) {
    const w = word.toLowerCase();
    need.set(w, (need.get(w) ?? 0) + 1);
    total += w.length;
  }
  const size = [...need.values()].reduce((a, b) => a + b, 0);
  if (size === 0) return null;
  const words: { word: string; start: number; end: number }[] = [];
  for (const match of text.matchAll(WORD)) words.push({ word: match[0].toLowerCase(), start: match.index, end: match.index + match[0].length });
  if (words.length < size) return null;
  const have = new Map<string, number>();
  let matched = 0;
  const add = (w: string) => {
    const n = have.get(w) ?? 0;
    if (n < (need.get(w) ?? 0)) matched += w.length;
    have.set(w, n + 1);
  };
  const remove = (w: string) => {
    const n = have.get(w)! - 1;
    have.set(w, n);
    if (n < (need.get(w) ?? 0)) matched -= w.length;
  };
  let best = -1;
  let bestMatched = 0;
  for (let i = 0; i < words.length; i++) {
    add(words[i].word);
    if (i >= size) remove(words[i - size].word);
    if (i < size - 1) continue;
    const first = i - size + 1;
    if (matched > bestMatched || (matched === bestMatched && best !== -1
      && Math.abs(words[first].start - anchor.start) < Math.abs(words[best].start - anchor.start))) {
      best = first;
      bestMatched = matched;
    }
  }
  if (best === -1 || bestMatched < MIN_SIMILARITY * total) return null;
  const start = words[best].start;
  const quote = text.slice(start, words[best + size - 1].end);
  return countUpTo(text, quote, 2) === 1 ? { quote, start, how: 'similar' } : null;
}
