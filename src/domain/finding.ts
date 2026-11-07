import { assessAnchor, matchesRevision, type Anchor, type EvidenceStatus } from './anchor.ts';
import { shortHash } from './claim.ts';
import type { Verdict } from './continuity.ts';

export const FINDING_QUESTIONS = ['motivation', 'consequences', 'knowledge'] as const;
export type FindingQuestion = (typeof FINDING_QUESTIONS)[number];

export const FINDING_KINDS = ['fact', 'interpretation', 'alternative'] as const;
export type FindingKind = (typeof FINDING_KINDS)[number];

export interface FindingEvidenceInput {
  file: string;
  quote: string;
}

export interface FindingEvidence {
  file: string;
  quote: string;
  revision: string;
  anchor: Anchor;
}

export interface FindingEvidenceView extends FindingEvidence {
  status: EvidenceStatus;
  reason: string;
  current_start?: number;
}

export interface FindingCandidate {
  question: FindingQuestion;
  kind: FindingKind;
  statement: string;
  characters?: string[];
  evidence: FindingEvidenceInput[];
}

export interface FindingVerdict {
  verdict: string;
  by: string;
  at: string;
  note?: string;
  history?: Array<{
    verdict: string;
    by: string;
    at: string;
    note?: string;
  }>;
}

export interface FindingRecord {
  finding_id: string;
  question: FindingQuestion;
  kind: FindingKind;
  statement: string;
  characters?: string[];
  evidence: FindingEvidence[];
  status: 'pending';
  author: string;
  created_at: string;
  verdict?: FindingVerdict | Verdict;
}

export interface FindingView extends Omit<FindingRecord, 'evidence'> {
  evidence: FindingEvidenceView[];
  evidence_status: EvidenceStatus;
}

/** Content-derived id so retries are harmless. */
export function findingId(candidate: FindingCandidate): string {
  const evidenceKeys = candidate.evidence.map((e) => `${e.file}:${e.quote}`).sort();
  const chars = (candidate.characters ?? []).slice().sort();
  return shortHash('F-', candidate.question, candidate.kind, candidate.statement, chars.join(','), evidenceKeys.join(';'));
}

/**
 * Recomputes evidence status for each cited quote from the scene text.
 * Overall status is valid only when every cited quote is valid; stale if any is stale;
 * orphaned if any is missing or orphaned.
 */
export function viewFinding(
  finding: FindingRecord,
  readScene: (file: string) => string | null,
  showAt?: (rev: string, file: string) => string | null,
): FindingView {
  const evidenceViews: FindingEvidenceView[] = finding.evidence.map((ev) => {
    if (showAt) {
      const atRevision = showAt(ev.revision, ev.file);
      if (atRevision === null || !matchesRevision(ev.anchor, atRevision)) {
        return {
          ...ev,
          status: 'orphaned',
          reason: 'quote_not_in_revision',
        };
      }
    }
    const current = readScene(ev.file);
    const assessment = assessAnchor(ev.anchor, current);
    return {
      ...ev,
      status: assessment.status,
      reason: assessment.reason,
      current_start: assessment.current_start,
    };
  });

  let overall: EvidenceStatus = 'valid';
  if (evidenceViews.some((ev) => ev.status === 'orphaned')) {
    overall = 'orphaned';
  } else if (evidenceViews.some((ev) => ev.status === 'stale')) {
    overall = 'stale';
  }

  return {
    ...finding,
    evidence: evidenceViews,
    evidence_status: overall,
  };
}
