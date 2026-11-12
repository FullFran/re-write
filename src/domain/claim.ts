import { createHash } from 'node:crypto';
import type { Anchor, EvidenceStatus } from './anchor.ts';
import type { ReanchorOffer } from './reanchor.ts';
import type { ClaimAttribute } from './claim-attribute.ts';

export const EPISTEMIC_KINDS = ['narrated_fact', 'belief', 'rumor', 'lie', 'inference'] as const;
export type EpistemicKind = (typeof EPISTEMIC_KINDS)[number];

export type EditorialStatus = 'proposed' | 'accepted' | 'rejected';
export type Decision = 'accept' | 'reject';

export interface HistoryEntry {
  at: string;
  by: string;
  from: string;
  to: string;
  note?: string;
  /**
   * Set when a person reopened a decision, asked to revert an accepted proposal, or accepted a new
   * anchor for a claim (the status does not change on the last two); absent on ordinary decisions
   * and on all older records.
   */
  action?: 'reopen' | 'revert' | 'reanchor';
  /** The proposal a `revert` entry created or reopened to undo this one. */
  ref?: string;
  /** On a `reanchor` entry: the new anchor and the revision it was taken from. The old anchor stays. */
  anchor?: Anchor;
  revision?: string;
  /** On a `reanchor` entry: the anchor proposal it accepted, when it came from one. */
  proposal?: string;
}

/** How a claim bears on what a character knows. */
export interface KnowledgeLink {
  holder: string;
  fact: string;
  mode: 'displays' | 'acquires' | 'hears';
}

/** What an extractor proposes. The application validates it before storing it. */
export interface ClaimCandidate {
  statement: string;
  subject: string;
  source_file: string;
  quote: string;
  scope: string;
  epistemic_kind: EpistemicKind;
  asserter?: string;
  epistemic_holder?: string;
  uncertainty?: string;
  story_time?: number;
  reveal_order?: number;
  knowledge?: KnowledgeLink;
  /** Optional structured value (age, duration, place, date) that continuity checks compare. */
  attribute?: ClaimAttribute;
}

export interface Claim extends Omit<ClaimCandidate, 'quote'> {
  claim_id: string;
  revision: string;
  anchor: Anchor;
  extractor: string;
  /** The authenticated person whose connection proposed this, when it came through the MCP. */
  proposed_by?: string;
  editorial_status: EditorialStatus;
  history: HistoryEntry[];
  /** Attributes given to the claim after it was stored, oldest first; only grows. Absent on older records. */
  attribute_history?: AttributeHistoryEntry[];
}

/** An attribute attached to a stored claim that had none, by whoever proposed the claim again. */
export interface AttributeHistoryEntry {
  at: string;
  by: string;
  attribute: ClaimAttribute;
}

/**
 * evidence_status is derived from the text on every read and is never stored. `anchor` and `revision`
 * are the current ones: the latest accepted new anchor, else the original. A proposed claim whose
 * evidence is not valid also carries a re-anchoring offer.
 */
export interface ClaimView extends Claim, Partial<ReanchorOffer> {
  evidence_status: EvidenceStatus;
  evidence_reason: string;
  current_start?: number;
}

/** The anchor a claim's evidence is read from now: the latest accepted new anchor, else the original. */
export function currentAnchor(claim: Claim): { anchor: Anchor; revision: string } {
  for (let i = claim.history.length - 1; i >= 0; i--) {
    const entry = claim.history[i];
    if (entry.action === 'reanchor' && entry.anchor && entry.revision) return { anchor: entry.anchor, revision: entry.revision };
  }
  return { anchor: claim.anchor, revision: claim.revision };
}

export function shortHash(prefix: string, ...parts: string[]): string {
  return prefix + createHash('sha256').update(parts.join('\u0000')).digest('hex').slice(0, 10);
}

/** The id ignores the revision, so re-extracting a later revision does not duplicate a claim. */
export function claimId(c: ClaimCandidate): string {
  return shortHash('C-', c.statement, c.source_file, c.quote);
}

/** Editorial transition: returns the new status, or null when the decision is already recorded. */
export function nextEditorialStatus(current: EditorialStatus, decision: Decision): EditorialStatus | null {
  const target: EditorialStatus = decision === 'accept' ? 'accepted' : 'rejected';
  if (current === target) return null;
  if (current !== 'proposed') throw new Error(`this was already ${current}`);
  return target;
}

/** A tab acted on a state that another tab or person has changed since. */
export class StaleStateError extends Error {
  constructor() {
    super('Esta decisión cambió en otra pestaña. Recarga para ver el estado actual.');
    this.name = 'StaleStateError';
  }
}

/**
 * Decides whether a reopen applies. `expected` is the history length the person saw, which only
 * grows (history is append-only), so it identifies the state they acted on. Returns 'reopen' when
 * the decision can be reopened, 'unchanged' when this exact reopen was already recorded (a repeated
 * click), and throws when nothing was decided or the state changed since.
 */
export function reopenTransition(status: EditorialStatus, history: HistoryEntry[], expected: number): 'reopen' | 'unchanged' {
  if (history.length === expected) {
    if (status === 'proposed') throw new Error('this was not decided yet; there is nothing to reopen');
    return 'reopen';
  }
  if (history.length === expected + 1 && status === 'proposed' && history.at(-1)?.action === 'reopen') return 'unchanged';
  throw new StaleStateError();
}

/**
 * Canon needs three things: a human accepted it, the text states it as a fact
 * of the world, and its evidence still holds. Accepting a rumor records that
 * the rumor exists in the book. It does not make the rumor true.
 */
export function isCanon(claim: ClaimView): boolean {
  return claim.editorial_status === 'accepted'
    && claim.epistemic_kind === 'narrated_fact'
    && claim.evidence_status === 'valid';
}
