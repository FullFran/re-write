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
