import { shortHash, type ClaimView } from './claim.ts';
import { inspectAttributes, type AttributeFindingKind, type AttributeMethod } from './attribute-continuity.ts';
import type { AttributeName } from './claim-attribute.ts';

export type Classification = 'possible_contradiction' | 'insufficient_evidence';
export const CONTINUITY_VERDICTS = ['confirmed', 'deliberate_mystery', 'false_positive'] as const;
// Persisted verdicts retain the complete legacy vocabulary.
export const VERDICTS = ['confirmed', 'deliberate_mystery', 'false_positive', 'useful', 'noise'] as const;
export type VerdictKind = (typeof VERDICTS)[number];

export class InvalidFindingVerdictError extends Error {
  constructor(family: string, allowed: readonly string[]) {
    super(`Invalid verdict for ${family} finding; expected: ${allowed.join(', ')}`);
    this.name = 'InvalidFindingVerdictError';
  }
}

/** A person took a verdict back, so the finding is pending again. */
export interface Reopening {
  by: string;
  at: string;
  note?: string;
}

export interface VerdictHistoryEntry {
  verdict: VerdictKind;
  by: string;
  at: string;
  note?: string;
  /** Set when this verdict was reopened before the next one was given. */
  reopened?: Reopening;
}

export interface Verdict {
  finding_id: string;
  verdict: VerdictKind;
  by: string;
  at: string;
  note?: string;
  history?: VerdictHistoryEntry[];
  /** Present while the verdict is reopened: the finding reads as pending, and the verdict is kept. */
  reopened?: Reopening;
}

/**
 * How a stored verdict shows on a finding: as its verdict, or, while reopened, as the kept verdict
 * next to a pending finding. Nothing when there is no verdict.
 */
export function verdictFields(record: Verdict | null): { verdict: Verdict } | { reopened_verdict: Verdict } | Record<string, never> {
  if (!record) return {};
  return record.reopened ? { reopened_verdict: record } : { verdict: record };
}

export interface Citation {
  claim_id: string;
  source_file: string;
  revision: string;
  quote: string;
  story_time?: number;
  reveal_order?: number;
  evidence_status: string;
}

interface FindingBase {
  finding_id: string;
  classification: Classification;
  explanation: string;
  citations: Citation[];
  alternatives: string[];
  verdict?: Verdict;
  /** While the verdict is reopened: the kept verdict, with its history and who reopened it. */
  reopened_verdict?: Verdict;
}

export interface KnowledgeFinding extends FindingBase {
  kind: 'knowledge_order';
  holder: string;
  fact: string;
  classification: Classification;
  method: 'rule:knowledge-order';
}

/** Two narrated facts about the same subject whose ages, durations, dates or places cannot all hold. */
export interface AttributeFinding extends FindingBase {
  kind: AttributeFindingKind;
  subject: string;
  attribute: AttributeName;
  method: AttributeMethod;
}

export type Finding = KnowledgeFinding | AttributeFinding;

const ALTERNATIVES = [
  'insufficient_evidence: the text may not establish when the character learned this',
  'deliberate_mystery: the author may be withholding how the character knows',
  'off_page: the character may have learned it in a moment the text does not show',
  'guess_or_lie: the character may be guessing or lying, and turn out to be right by chance',
];

export function cite(claim: ClaimView): Citation {
  return {
    claim_id: claim.claim_id,
    source_file: claim.source_file,
    revision: claim.revision,
    quote: claim.anchor.quote,
    story_time: claim.story_time,
    reveal_order: claim.reveal_order,
    evidence_status: claim.evidence_status,
  };
}

function earliest(claims: ClaimView[]): ClaimView | undefined {
  return claims
    .filter((c) => c.story_time !== undefined)
    .sort((a, b) => a.story_time! - b.story_time!)[0];
}

/**
 * A heuristic over annotated knowledge links, not a judgment about the book.
 * It compares story time, not reading order, so a flashback is not a leak. It
 * only claims a possible contradiction when the two quotes are current and the
 * order is known, and otherwise says the evidence is insufficient.
 */
export function inspectContinuity(claims: ClaimView[]): Finding[] {
  return [...inspectKnowledgeOrder(claims), ...inspectAttributes(claims)];
}

function inspectKnowledgeOrder(claims: ClaimView[]): KnowledgeFinding[] {
  const usable = claims.filter((c) =>
    c.knowledge && c.editorial_status !== 'rejected' && c.evidence_status !== 'orphaned');
  const findings: KnowledgeFinding[] = [];
  for (const shown of usable.filter((c) => c.knowledge!.mode === 'displays')) {
    const { holder, fact } = shown.knowledge!;
    const related = usable.filter((c) => c.knowledge!.holder === holder && c.knowledge!.fact === fact);
    const acquired = related.filter((c) => c.knowledge!.mode === 'acquires');
    const firstAcquired = earliest(acquired);
    const make = (classification: Classification, explanation: string, cited: ClaimView[]): KnowledgeFinding => ({
      finding_id: shortHash('F-', holder, fact, shown.claim_id),
      kind: 'knowledge_order',
      holder,
      fact,
      classification,
      method: 'rule:knowledge-order',
      explanation,
      citations: cited.map(cite),
      alternatives: ALTERNATIVES,
    });

    if (acquired.length === 0) {
      findings.push(make('insufficient_evidence',
        `${holder} shows this knowledge, but no current claim records how ${holder} learned it.`, [shown]));
      continue;
    }
    if (shown.story_time === undefined || !firstAcquired) {
      findings.push(make('insufficient_evidence',
        'The order is unknown because a claim has no story time.', [shown, ...acquired]));
      continue;
    }
    if (shown.story_time >= firstAcquired.story_time!) continue;

    const cited = [shown, firstAcquired];
    const heardEarlier = related.filter((c) =>
      c.knowledge!.mode === 'hears' && c.story_time !== undefined && c.story_time <= shown.story_time!);
    if (heardEarlier.length) {
      findings.push(make('insufficient_evidence',
        `${holder} may be repeating something heard earlier rather than knowing it.`, [...cited, ...heardEarlier]));
    } else if (cited.some((c) => c.evidence_status === 'stale')) {
      findings.push(make('insufficient_evidence',
        'A quote is stale: the text around it changed, so re-read it before relying on this.', cited));
    } else {
      findings.push(make('possible_contradiction',
        `${holder} shows this knowledge at story time ${shown.story_time}, before learning it at story time ${firstAcquired.story_time}.`, cited));
    }
  }
  return findings;
}
