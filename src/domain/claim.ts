import { createHash } from 'node:crypto';
import type { Anchor, EvidenceStatus } from './anchor.ts';

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
}

/** evidence_status is derived from the text on every read and is never stored. */
export interface ClaimView extends Claim {
  evidence_status: EvidenceStatus;
  evidence_reason: string;
  current_start?: number;
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
