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
  status: EditorialStatus;
  history: HistoryEntry[];
}

/** Same base text and same change give the same id, so retries cannot duplicate a proposal. */
export function proposalId(file: string, baseBlob: string, find: string, replace: string): string {
  return shortHash('P-', file, baseBlob, find, replace);
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
