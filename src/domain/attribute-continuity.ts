import { shortHash, type ClaimView } from './claim.ts';
import { compareDates, fold, parseDate, parseSpanishNumber, unitOf, type AttributeName } from './claim-attribute.ts';
import { cite, type AttributeFinding, type Classification } from './continuity.ts';

export type AttributeFindingKind = 'age' | 'duration' | 'date' | 'place';
export type AttributeMethod = 'rule:attribute-growth' | 'rule:attribute-fixed' | 'rule:date-order';

const COMMON = [
  'mistake: it may be an error in the text or in the annotation',
  'unreliable_narrator: the narrator may be wrong, or not telling the truth',
];
const ALTERNATIVES: Record<AttributeMethod, string[]> = {
  'rule:attribute-growth': [
    COMMON[0],
    'time_jump: the scenes may be further apart, or in another order, than their story time says',
    COMMON[1],
    'different_reference: the two figures may count from different moments or refer to different things',
  ],
  'rule:date-order': [
    COMMON[0],
    'time_jump: the story time of a scene may be wrong, or a flashback may be dated as if it came later',
    COMMON[1],
  ],
  'rule:attribute-fixed': [
    COMMON[0],
    'moved_or_rebuilt: the place may have moved, or been rebuilt somewhere else, between the two scenes',
    'two_places: there may be two places with the same name',
    COMMON[1],
  ],
};

const STALE = 'A quote is stale: the text around it changed, so re-read it before relying on this.';

interface Item {
  claim: ClaimView;
  /** Comparable value: a number for ages and durations, date parts for dates, a folded key for places. */
  value: number | number[] | string;
  /** How the value reads in an explanation. */
  shown: string;
  time: number;
}

const byTime = (a: Item, b: Item) => a.time - b.time
  || (a.claim.reveal_order ?? Infinity) - (b.claim.reveal_order ?? Infinity)
  || (a.claim.claim_id < b.claim.claim_id ? -1 : a.claim.claim_id > b.claim.claim_id ? 1 : 0);

const quoted = (item: Item) => `"${item.claim.anchor.quote}" (story time ${item.claim.story_time ?? 'unknown'}) gives ${item.shown}`;

function item(claim: ClaimView): { key: string; item: Item } | null {
  const a = claim.attribute!;
  const base = [a.name, fold(claim.subject), fold(a.about ?? '')];
  const time = claim.story_time ?? Infinity;
  if (a.name === 'edad' || a.name === 'años_en') {
    const value = parseSpanishNumber(a.value);
    const unit = unitOf(a);
    if (value === null || unit === null) return null;
    return { key: [...base, unit].join('\u0000'), item: { claim, value, shown: `${value} ${unit}`, time } };
  }
  if (a.name === 'fecha') {
    const value = parseDate(a.value);
    return value && { key: base.join('\u0000'), item: { claim, value, shown: String(a.value), time } };
  }
  const value = fold(String(a.value));
  return value ? { key: base.join('\u0000'), item: { claim, value, shown: String(a.value).trim(), time } } : null;
}

/**
 * Ages, durations, dates and places stated as narrated facts about the same subject that cannot all
 * hold. Heuristics, not verdicts: only narrated facts are compared (a rumor or a belief that disagrees
 * may be the point), and story time decides the order. Each group is sorted once and swept, so the
 * work is n log n per subject.
 */
export function inspectAttributes(claims: ClaimView[]): AttributeFinding[] {
  const groups = new Map<string, Item[]>();
  for (const claim of claims) {
    if (!claim.attribute || claim.epistemic_kind !== 'narrated_fact') continue;
    if (claim.editorial_status === 'rejected' || claim.evidence_status === 'orphaned') continue;
    const entry = item(claim);
    if (!entry) continue;
    const group = groups.get(entry.key);
    if (group) group.push(entry.item);
    else groups.set(entry.key, [entry.item]);
  }
  const findings = new Map<string, AttributeFinding>();
  for (const items of groups.values()) {
    if (items.length < 2) continue;
    items.sort(byTime);
    const name = items[0].claim.attribute!.name;
    const add = (method: AttributeMethod, classification: Classification, explanation: string, cited: Item[]) => {
      const kind: AttributeFindingKind = name === 'edad' ? 'age' : name === 'años_en' ? 'duration' : name === 'fecha' ? 'date' : 'place';
      const stale = classification === 'possible_contradiction' && cited.some((i) => i.claim.evidence_status === 'stale');
      const finding_id = shortHash('F-', kind, fold(items[0].claim.subject), ...cited.map((i) => i.claim.claim_id).sort());
      if (findings.has(finding_id)) return;
      findings.set(finding_id, {
        finding_id,
        kind,
        subject: items[0].claim.subject,
        attribute: name,
        classification: stale ? 'insufficient_evidence' : classification,
        method,
        explanation: stale ? `${explanation} ${STALE}` : explanation,
        citations: cited.map((i) => cite(i.claim)),
        alternatives: ALTERNATIVES[method],
      });
    };
    if (name === 'edad' || name === 'años_en') growth(items, add);
    else if (name === 'fecha') dateOrder(items, add);
    else fixed(items, add);
  }
  return [...findings.values()];
}

type Add = (method: AttributeMethod, classification: Classification, explanation: string, cited: Item[]) => void;

function label(item: Item): string {
  const a = item.claim.attribute!;
  if (a.name === 'edad') return `${item.claim.subject}'s age`;
  return a.about ? `${item.claim.subject}'s time in ${a.about}` : `${item.claim.subject}'s duration`;
}

/** Ages and durations may grow as story time passes, never shrink, and agree at the same story time. */
function growth(items: Item[], add: Add): void {
  const method = 'rule:attribute-growth';
  const dated = items.filter((i) => i.time !== Infinity);
  let before: Item | undefined; // the largest value at an earlier story time
  for (let start = 0; start < dated.length;) {
    let end = start;
    while (end < dated.length && dated[end].time === dated[start].time) end++;
    const moment = dated.slice(start, end);
    const low = moment.reduce((a, b) => ((b.value as number) < (a.value as number) ? b : a));
    const high = moment.reduce((a, b) => ((b.value as number) > (a.value as number) ? b : a));
    if (low.value !== high.value) {
      add(method, 'possible_contradiction',
        `${label(low)} differs at the same story time ${low.claim.story_time}: ${quoted(low)}, while ${quoted(high)}.`, [low, high].sort(byTime));
    }
    if (before) {
      for (const later of moment) {
        if ((later.value as number) < (before.value as number)) {
          add(method, 'possible_contradiction',
            `${label(later)} shrinks as story time moves forward: ${quoted(before)}, but later ${quoted(later)}.`, [before, later]);
        }
      }
    }
    if (!before || (high.value as number) > (before.value as number)) before = high;
    start = end;
  }
  const low = items.reduce((a, b) => ((b.value as number) < (a.value as number) ? b : a));
  const high = items.reduce((a, b) => ((b.value as number) > (a.value as number) ? b : a));
  for (const undated of items.filter((i) => i.time === Infinity)) {
    const other = undated.value !== high.value ? high : undated.value !== low.value ? low : undefined;
    if (!other) continue;
    add(method, 'insufficient_evidence',
      `The order is unknown because a claim has no story time: ${quoted(other)}, and ${quoted(undated)}.`, [other, undated].sort(byTime));
  }
}

/** Dates about the same subject keep the order story time gives them. */
function dateOrder(items: Item[], add: Add): void {
  let latest: Item | undefined; // the latest date at an earlier story time
  for (let start = 0; start < items.length && items[start].time !== Infinity;) {
    let end = start;
    while (end < items.length && items[end].time === items[start].time) end++;
    const moment = items.slice(start, end);
    if (latest) {
      for (const later of moment) {
        if (compareDates(later.value as number[], latest.value as number[]) < 0) {
          add('rule:date-order', 'possible_contradiction',
            `${later.claim.subject}'s dates run against story time: ${quoted(latest)}, but the later ${quoted(later)}, an earlier date.`, [latest, later]);
        }
      }
    }
    for (const candidate of moment) {
      const order = latest ? compareDates(candidate.value as number[], latest.value as number[]) : 1;
      // Equal on the parts both have: keep the more precise date, so "1888" then "1888-05-01" keeps May.
      if (order > 0 || (order === 0 && (candidate.value as number[]).length > (latest!.value as number[]).length)) latest = candidate;
    }
    start = end;
  }
}

/** A place that does not move has one value. */
function fixed(items: Item[], add: Add): void {
  const first = new Map<string, Item>();
  for (const i of items) if (!first.has(i.value as string)) first.set(i.value as string, i);
  const [original, ...others] = first.values();
  for (const other of others) {
    add('rule:attribute-fixed', 'possible_contradiction',
      `${other.claim.subject} is in two places: ${quoted(original)}, but ${quoted(other)}.`, [original, other]);
  }
}
