import { shortHash, type EditorialStatus, type HistoryEntry } from './claim.ts';

export interface Proposal {
  proposal_id: string;
  file: string;
  base_revision: string;
  base_blob: string;
  find: string;
  replace: string;
  rationale: string;
  finding_id?: string;
  proposed_by?: string;
  /** The accepted proposal this one undoes (an inverse proposal). */
  reverts?: string;
  /** The proposal whose change this one proposes again against a later text. */
  reproposes?: string;
  status: EditorialStatus;
  history: HistoryEntry[];
}

/**
 * Same base text and same change give the same id, so retries cannot duplicate a proposal. A change
 * proposed again from an earlier proposal also hashes that origin: after a revert the text is back
 * to the earlier base, and without it the new proposal would get the accepted one's id.
 */
export function proposalId(file: string, baseBlob: string, find: string, replace: string, reproposes?: string): string {
  return reproposes ? shortHash('P-', file, baseBlob, find, replace, `again:${reproposes}`) : shortHash('P-', file, baseBlob, find, replace);
}

/** Replaces the single occurrence of `find`, refusing any change that is not exact. */
export function applyChange(text: string, find: string, replace: string): string {
  const first = text.indexOf(find);
  if (!find || first === -1) throw new Error('text to change was not found in the scene');
  let count = 0;
  for (let at = first; at !== -1; at = text.indexOf(find, at + 1)) count += 1;
  if (count > 1) throw new Error(`text to change appears ${count} times; use a longer passage`);
  if (find === replace) throw new Error('this proposal changes nothing');
  return text.slice(0, first) + replace + text.slice(first + find.length);
}

function occurrences(text: string, passage: string): number {
  let count = 0;
  for (let at = text.indexOf(passage); at !== -1; at = text.indexOf(passage, at + 1)) count += 1;
  return count;
}

/** Context taken on each side of a reverted passage before it must also be unique. */
const MIN_CONTEXT = 16;

/**
 * The change that undoes an accepted `find` -> `replace` made on `base`, as it applies to `current`.
 * The replaced passage is located in the accepted text with some context on each side, and the
 * context grows until that passage appears exactly once in the current text, so later edits
 * elsewhere in the scene are kept. Returns null when later edits touched the passage or its
 * surroundings, or left it ambiguous: then it cannot be reverted automatically.
 */
export function inverseChange(base: string, find: string, replace: string, current: string): { find: string; replace: string } | null {
  const start = base.indexOf(find);
  if (start === -1) return null;
  const after = applyChange(base, find, replace);
  const end = start + replace.length;
  for (let context = MIN_CONTEXT; ; context *= 2) {
    const left = after.slice(Math.max(0, start - context), start);
    const right = after.slice(end, end + context);
    const passage = left + replace + right;
    const count = passage ? occurrences(current, passage) : 0;
    if (count === 0) return null;
    if (count === 1) return { find: passage, replace: left + find + right };
    if (start - context <= 0 && end + context >= after.length) return null;
  }
}
