import type { Anchor, AnchorSuggestion } from './anchor.ts';
import { shortHash, StaleStateError } from './claim.ts';

/**
 * A new anchor a person accepted for evidence that went stale or orphaned. It is appended, never
 * written over the old anchor: a claim keeps it as a history entry, a finding in its `reanchors` list.
 */
export interface Reanchor {
  at: string;
  by: string;
  /** The finding evidence it replaces, by position; absent on a claim, which has one quote. */
  evidence?: number;
  revision: string;
  anchor: Anchor;
  note?: string;
  /** The anchor proposal it accepted, when it came from one. */
  proposal?: string;
}

export type AnchorTarget = 'claim' | 'finding';

/** A new anchor an agent proposed through the MCP. Only a person accepts it, in the review page. */
export interface AnchorProposal {
  anchor_proposal_id: string;
  target: AnchorTarget;
  item_id: string;
  evidence?: number;
  /** The item's history length when it was proposed: any later decision or new anchor supersedes it. */
  base: number;
  file: string;
  quote: string;
  revision: string;
  anchor: Anchor;
  rationale?: string;
  proposed_by: string;
  created_at: string;
}

/** What a review card needs to re-anchor one piece of evidence; only set while it can be re-anchored. */
export interface ReanchorOffer {
  /** The passage the current text most likely means now, or null: no passage was found. */
  anchor_suggestion: AnchorSuggestion | null;
  /** Open anchor proposals from agents, oldest first. */
  anchor_proposals: AnchorProposal[];
}

/** Content-derived, so repeating a proposal on the same state stores it once. */
export function anchorProposalId(target: AnchorTarget, itemId: string, evidence: number | undefined, quote: string, base: number): string {
  return shortHash('A-', target, itemId, String(evidence ?? ''), quote, String(base));
}

/**
 * Decides whether a re-anchor applies. `expected` is the history length the person saw. The same
 * quote already recorded by the very next entry is a repeat (another tab, a retry) and changes
 * nothing; any other change since is refused.
 */
export function reanchorTransition(length: number, expected: number, last: Reanchor | undefined, quote: string, evidence?: number): 'reanchor' | 'unchanged' {
  if (length === expected) return 'reanchor';
  if (length === expected + 1 && last && last.anchor.quote === quote && last.evidence === evidence) return 'unchanged';
  throw new StaleStateError();
}
