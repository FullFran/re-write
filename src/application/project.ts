import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, join, normalize, resolve } from 'node:path';
import { Git } from '../adapters/git.ts';
import { JsonStore, STATE_DIR } from '../adapters/json-store.ts';
import type { Extraction } from '../adapters/annotation-extractor.ts';
import { assessAnchor, buildAnchor, matchesRevision } from '../domain/anchor.ts';
import {
  claimId, EPISTEMIC_KINDS, isCanon, nextEditorialStatus, reopenTransition, StaleStateError,
  type Claim, type ClaimCandidate, type ClaimView, type Decision,
} from '../domain/claim.ts';
import { verdictFields, CONTINUITY_VERDICTS, InvalidFindingVerdictError, inspectContinuity, type Finding, type Verdict, type VerdictHistoryEntry, type VerdictKind } from '../domain/continuity.ts';
import { applyChange, inverseChange, proposalId, type Proposal } from '../domain/proposal.ts';
import {
  NARRATIVE_VERDICTS, findingId, viewFinding,
  type FindingCandidate, type FindingRecord, type FindingView,
} from '../domain/finding.ts';

const SCENES_DIR = 'scenes';
/** A markdown file directly inside scenes: never the directory itself, which git can also show. */
const SCENE_FILE = /^scenes\/[^/]+\.md$/;

export function reviewer(by: string | undefined): string {
  return by || process.env.USER || 'unknown';
}

export class Project {
  readonly dir: string;
  readonly git: Git;
  readonly claims: JsonStore<Claim>;
  readonly verdicts: JsonStore<Verdict>;
  readonly proposals: JsonStore<Proposal>;
  readonly findings: JsonStore<FindingRecord>;

  constructor(dir: string) {
    this.dir = resolve(dir);
    this.git = new Git(this.dir);
    this.claims = new JsonStore<Claim>(this.dir, 'claims');
    this.verdicts = new JsonStore<Verdict>(this.dir, 'verdicts');
    this.proposals = new JsonStore<Proposal>(this.dir, 'proposals');
    this.findings = new JsonStore<FindingRecord>(this.dir, 'findings');
  }

  /** Creates the book repository. Opening an existing book changes nothing. */
  static init(dir: string, title: string): { project: Project; created: boolean } {
    const project = new Project(dir);
    const manifest = new JsonStore<{ title: string }>(project.dir, '.');
    if (manifest.get('project')) return { project, created: false };
    mkdirSync(project.dir, { recursive: true });
    project.git.init();
    project.commitWrites(`rewrite: create project ${title}`, [join(STATE_DIR, 'project.json')], () => manifest.put('project', { title }));
    return { project, created: true };
  }

  static open(dir: string): Project {
    const project = new Project(dir);
    if (!new JsonStore<{ title: string }>(project.dir, '.').get('project')) {
      throw new Error(`${project.dir} is not a RE;write project (run init first)`);
    }
    return project;
  }

  title(): string {
    return new JsonStore<{ title: string }>(this.dir, '.').get('project')!.title;
  }

  scenes(): string[] {
    const dir = join(this.dir, SCENES_DIR);
    if (!existsSync(dir)) return [];
    return readdirSync(dir).filter((name) => name.endsWith('.md')).sort().map((name) => `${SCENES_DIR}/${name}`);
  }

  /** Copies scenes in and commits them. It never overwrites a scene with different text. */
  importScenes(files: string[]): { imported: string[]; unchanged: string[] } {
    const seen = new Set<string>();
    for (const file of files) {
      if (file.includes('\0')) {
        throw new Error(`invalid scene file name: contains NUL byte: ${file}`);
      }
      const base = basename(file);
      if (base.includes('\0')) {
        throw new Error(`invalid scene file name: contains NUL byte: ${base}`);
      }
      if (Buffer.byteLength(base, 'utf8') > 255) {
        throw new Error(`file name too long: ${base} exceeds 255 bytes`);
      }
      const relative = `${SCENES_DIR}/${base}`;
      if (base.startsWith('.') || !base.endsWith('.md') || !SCENE_FILE.test(relative)) {
        throw new Error(`only Markdown (.md) files are supported: ${base}`);
      }
      if (seen.has(base)) {
        throw new Error(`duplicate file name in import batch: ${base}`);
      }
      seen.add(base);
      const target = join(this.dir, relative);
      if (existsSync(target)) {
        if (readFileSync(target, 'utf8') !== readFileSync(file, 'utf8')) {
          throw new Error(`${relative} already exists with different text; edit it through a proposal`);
        }
      }
    }
    const copies: [from: string, to: string][] = [];
    const unchanged: string[] = [];
    for (const file of files) {
      const relative = `${SCENES_DIR}/${basename(file)}`;
      if (existsSync(join(this.dir, relative))) unchanged.push(relative);
      else copies.push([file, relative]);
    }
    const imported = copies.map(([, relative]) => relative);
    if (imported.length) {
      this.commitWrites(`rewrite: import ${imported.join(', ')}`, imported, () => {
        mkdirSync(join(this.dir, SCENES_DIR), { recursive: true });
        for (const [from, relative] of copies) copyFileSync(from, join(this.dir, relative));
      });
    }
    return { imported, unchanged };
  }

  /** Returns a safe scene path, or throws when it would leave the scenes directory. */
  scenePath(file: string): string {
    const clean = normalize(file);
    if (!SCENE_FILE.test(clean) || clean.includes('..')) {
      throw new Error(`source_file must be inside ${SCENES_DIR}/: ${file}`);
    }
    return clean;
  }

  /** Reads the current text of a scene, or null when it no longer exists. */
  readScene(file: string): string | null {
    const path = join(this.dir, this.scenePath(file));
    return existsSync(path) && statSync(path).isFile() ? readFileSync(path, 'utf8') : null;
  }

  /** Validates candidates against the committed text and stores them as proposed. */
  extractClaims(extraction: Extraction, proposedBy?: string): {
    created: string[]; existing: string[]; rejected: { statement: string; reason: string }[];
  } {
    const revision = this.git.head();
    const created: string[] = [];
    const existing: string[] = [];
    const rejected: { statement: string; reason: string }[] = [];
    const built = new Map<string, Claim>();
    for (const candidate of extraction.candidates) {
      try {
        const id = claimId(candidate);
        if (this.claims.get(id) || built.has(id)) {
          existing.push(id);
          continue;
        }
        const claim = this.buildClaim(id, candidate, revision, extraction.extractor);
        built.set(id, proposedBy ? { ...claim, proposed_by: proposedBy } : claim);
        created.push(id);
      } catch (error) {
        rejected.push({ statement: candidate.statement, reason: (error as Error).message });
      }
    }
    if (created.length) {
      this.saveRecords(`rewrite: extract ${created.length} claims`, created.map((id) => ['claims', id]), () => {
        for (const [id, claim] of built) this.claims.put(id, claim);
      });
    }
    return { created, existing, rejected };
  }

  private buildClaim(id: string, candidate: ClaimCandidate, revision: string, extractor: string): Claim {
    const { quote, ...fields } = candidate;
    if (!quote) throw new Error('quote is empty');
    if (!EPISTEMIC_KINDS.includes(candidate.epistemic_kind)) {
      throw new Error(`unknown epistemic_kind: ${candidate.epistemic_kind}`);
    }
    const file = this.scenePath(candidate.source_file);
    const text = this.git.showAt(revision, file);
    if (text === null) throw new Error(`${file} not found at revision ${revision}`);
    return {
      ...fields,
      claim_id: id,
      source_file: file,
      revision,
      anchor: buildAnchor(text, quote),
      extractor,
      editorial_status: 'proposed',
      history: [],
    };
  }

  /** Adds the evidence status, always recomputed from the recorded revision and the current text. */
  view(claim: Claim): ClaimView {
    // A stored record with an unusable path is reported as broken, and must not take the whole book down.
    if (!SCENE_FILE.test(normalize(claim.source_file)) || claim.source_file.includes('..')) {
      return { ...claim, evidence_status: 'orphaned', evidence_reason: 'file_missing' };
    }
    const atRevision = this.git.showAt(claim.revision, claim.source_file);
    if (atRevision === null || !matchesRevision(claim.anchor, atRevision)) {
      return { ...claim, evidence_status: 'orphaned', evidence_reason: 'quote_not_in_revision' };
    }
    const assessment = assessAnchor(claim.anchor, this.readScene(claim.source_file));
    return {
      ...claim,
      evidence_status: assessment.status,
      evidence_reason: assessment.reason,
      current_start: assessment.current_start,
    };
  }

  claimViews(): ClaimView[] {
    return this.claims.all().map((claim) => this.view(claim));
  }

  canon(): ClaimView[] {
    return this.claimViews().filter(isCanon);
  }

  reviewClaim(id: string, decision: Decision, by: string, note?: string, expected?: number): { claim: ClaimView; changed: boolean } {
    const claim = this.claims.get(id);
    if (!claim) throw new Error(`unknown claim: ${id}`);
    checkExpected(claim.editorial_status, claim.history, decision, expected);
    const next = nextEditorialStatus(claim.editorial_status, decision);
    if (next === null) return { claim: this.view(claim), changed: false };
    const current = this.view(claim);
    if (decision === 'accept' && current.evidence_status !== 'valid') {
      throw new Error(`cannot accept ${id}: evidence is ${current.evidence_status} (${current.evidence_reason})`);
    }
    claim.history.push({ at: new Date().toISOString(), by, from: claim.editorial_status, to: next, ...(note ? { note } : {}) });
    claim.editorial_status = next;
    this.saveRecords(`rewrite: ${decision} claim ${id}`, [['claims', id]], () => this.claims.put(id, claim));
    return { claim: this.view(claim), changed: true };
  }

  /**
   * A person takes back an accept or reject: the claim is proposed again, so it leaves Canon until
   * it is accepted again with valid evidence. The text never changes and the history only grows.
   */
  reopenClaim(id: string, by: string, expected: number, note?: string): { claim: ClaimView; changed: boolean } {
    const claim = this.claims.get(id);
    if (!claim) throw new Error(`unknown claim: ${id}`);
    if (reopenTransition(claim.editorial_status, claim.history, expected) === 'unchanged') return { claim: this.view(claim), changed: false };
    claim.history.push({ at: new Date().toISOString(), by, from: claim.editorial_status, to: 'proposed', ...(note ? { note } : {}), action: 'reopen' });
    claim.editorial_status = 'proposed';
    this.saveRecords(`rewrite: reopen claim ${id}`, [['claims', id]], () => this.claims.put(id, claim));
    return { claim: this.view(claim), changed: true };
  }

  /** Writes records and commits exactly those records (see commitWrites). */
  private saveRecords(message: string, records: [collection: string, id: string][], write: () => void): void {
    this.commitWrites(message, records.map(([collection, id]) => recordPath(collection, id)), write);
  }

  /**
   * Runs `write`, which may only touch these repository paths, and commits exactly those paths, so
   * nothing else in the book is swept into the commit. When the write or the commit fails, every path
   * is put back byte for byte (or removed when it did not exist) and unstaged, so the book is exactly
   * as it was and a retry starts from a clean state. Every write that commits goes through here.
   */
  private commitWrites(message: string, paths: string[], write: () => void): void {
    const before = paths.map((path) => (existsSync(join(this.dir, path)) ? readFileSync(join(this.dir, path)) : null));
    try {
      write();
      this.git.commit(message, paths);
    } catch (error) {
      paths.forEach((path, i) => {
        const bytes = before[i];
        if (bytes === null) rmSync(join(this.dir, path), { force: true });
        else writeFileSync(join(this.dir, path), bytes);
      });
      this.git.tryRun('reset', '-q', '--', ...paths);
      throw error;
    }
  }

  /** Everything a reviewer needs for one book, recomputed from the text on each read. */
  reviewQueue(): {
    claims: ClaimView[];
    canon: ClaimView[];
    findings: Finding[];
    finding_views: FindingView[];
    proposals: ReturnType<Project['showProposal']>[];
  } {
    return {
      claims: this.claimViews(),
      canon: this.canon(),
      findings: this.check(),
      finding_views: this.findingViews(),
      proposals: this.proposals.all().map((p) => this.showProposal(p.proposal_id)),
    };
  }

  /** Read-only: it computes findings and attaches any verdict a human already gave. */
  check(): Finding[] {
    return inspectContinuity(this.claimViews()).map((finding) => {
      return { ...finding, ...verdictFields(this.verdicts.get(finding.finding_id)) };
    });
  }

  reviewFinding(id: string, verdict: VerdictKind, by: string, note?: string): Verdict {
    const isContinuity = this.check().some((finding) => finding.finding_id === id);
    const isNarrative = this.findings.get(id) !== null;
    if (!isContinuity && !isNarrative) throw new Error(`unknown finding: ${id}`);
    const allowed: readonly string[] = isContinuity ? CONTINUITY_VERDICTS : NARRATIVE_VERDICTS;
    if (!allowed.includes(verdict)) {
      throw new InvalidFindingVerdictError(isContinuity ? 'continuity' : 'narrative', allowed);
    }
    const existing = this.verdicts.get(id);
    const history: VerdictHistoryEntry[] = existing?.history ? [...existing.history] : [];
    if (existing) {
      history.push({
        verdict: existing.verdict,
        by: existing.by,
        at: existing.at,
        ...(existing.note ? { note: existing.note } : {}),
        ...(existing.reopened ? { reopened: existing.reopened } : {}),
      });
    }
    const record: Verdict = {
      finding_id: id,
      verdict,
      by,
      at: new Date().toISOString(),
      ...(note ? { note } : {}),
      ...(history.length ? { history } : {}),
    };
    this.saveRecords(`rewrite: ${verdict} finding ${id}`, [['verdicts', id]], () => this.verdicts.put(id, record));
    return record;
  }

  /**
   * A person takes back a verdict, so the finding reads as pending again. The verdict stays in the
   * record with who reopened it and when, and moves into the history when the next verdict is given.
   * `expected` is the time of the verdict the person saw.
   */
  reopenFinding(id: string, by: string, expected: string, note?: string): { verdict: Verdict; changed: boolean } {
    const record = this.verdicts.get(id);
    if (!record) {
      const known = this.findings.get(id) !== null || this.check().some((finding) => finding.finding_id === id);
      throw new Error(known ? 'this was not decided yet; there is nothing to reopen' : `unknown finding: ${id}`);
    }
    if (record.at !== expected) throw new StaleStateError();
    if (record.reopened) return { verdict: record, changed: false };
    record.reopened = { by, at: new Date().toISOString(), ...(note ? { note } : {}) };
    this.saveRecords(`rewrite: reopen finding ${id}`, [['verdicts', id]], () => this.verdicts.put(id, record));
    return { verdict: record, changed: true };
  }

  /**
   * Proposes narrative findings with literal quotes. Rejects the whole call
   * naming the offending quote if any quote is not literal in the current scene text.
   * Repeating a call creates no duplicates.
   */
  proposeFindings(
    candidates: FindingCandidate[],
    author: string,
  ): { created: string[]; existing: string[]; findings: FindingView[] } {
    for (const candidate of candidates) {
      if (!candidate.evidence?.length) throw new Error('each finding must cite at least one quote');
      for (const ev of candidate.evidence) {
        if (!ev.quote) throw new Error('quote is empty');
        const file = this.scenePath(ev.file);
        const text = this.readScene(file);
        if (text === null) throw new Error(`scene not found: ${file} for quote "${ev.quote}"`);
        try {
          buildAnchor(text, ev.quote);
        } catch (error) {
          throw new Error(`quote not literal in ${file}: "${ev.quote}" (${(error as Error).message})`);
        }
      }
    }

    const revision = this.git.head();
    const created: string[] = [];
    const existing: string[] = [];

    const records = new Map<string, FindingRecord>();
    for (const candidate of candidates) {
      const id = findingId(candidate);
      if (this.findings.get(id) || records.has(id)) {
        existing.push(id);
        continue;
      }
      const record: FindingRecord = {
        finding_id: id,
        question: candidate.question,
        kind: candidate.kind,
        statement: candidate.statement,
        ...(candidate.characters?.length ? { characters: candidate.characters } : {}),
        evidence: candidate.evidence.map((ev) => {
          const file = this.scenePath(ev.file);
          const text = this.readScene(file)!;
          return {
            file,
            quote: ev.quote,
            revision,
            anchor: buildAnchor(text, ev.quote),
          };
        }),
        status: 'pending',
        author,
        created_at: new Date().toISOString(),
      };
      records.set(id, record);
      created.push(id);
    }

    if (created.length) {
      this.saveRecords(`rewrite: propose ${created.length} findings`, created.map((id) => ['findings', id]), () => {
        for (const [id, record] of records) this.findings.put(id, record);
      });
    }
    // Only this call's findings, in the order submitted, so the response does not grow with the book;
    // list_findings reads the rest.
    const own = [...new Set(candidates.map(findingId))].map((id) => this.findings.get(id)!);
    return { created, existing, findings: own.map((f) => this.findingView(f)) };
  }

  findingViews(): FindingView[] {
    return this.findings.all().map((f) => this.findingView(f));
  }

  private findingView(f: FindingRecord): FindingView {
    const view = viewFinding(
      f,
      (file) => this.readScene(file),
      (rev, file) => this.git.showAt(rev, file),
    );
    return { ...view, ...verdictFields(this.verdicts.get(f.finding_id)) };
  }

  /** Stores a change for review. It never writes to the scene. */
  proposeRevision(input: ProposalInput): { proposal: Proposal; created: boolean } {
    const proposal = this.buildProposal(input);
    const existing = this.proposals.get(proposal.proposal_id);
    if (existing) return { proposal: existing, created: false };
    this.saveRecords(`rewrite: propose ${proposal.proposal_id}`, [['proposals', proposal.proposal_id]], () => this.proposals.put(proposal.proposal_id, proposal));
    return { proposal, created: true };
  }

  /** Validates a change against the current committed text and builds its proposal, without storing it. */
  private buildProposal(input: ProposalInput): Proposal {
    const file = this.scenePath(input.file);
    const text = this.readScene(file);
    if (text === null) throw new Error(`scene not found: ${file}`);
    if (this.git.isDirty(file)) throw new Error(`${file} has uncommitted edits; commit them before proposing a change`);
    if (input.find.includes('\u0000') || input.replace.includes('\u0000')) {
      throw new Error('a proposal cannot contain NUL characters');
    }
    applyChange(text, input.find, input.replace);
    if (input.finding_id && !this.check().some((f) => f.finding_id === input.finding_id)) {
      throw new Error(`unknown finding: ${input.finding_id}`);
    }
    const baseBlob = this.git.blobOf(file);
    return {
      proposal_id: proposalId(file, baseBlob, input.find, input.replace, input.reproposes),
      file,
      base_revision: this.git.head(),
      base_blob: baseBlob,
      find: input.find,
      replace: input.replace,
      rationale: input.rationale,
      ...(input.finding_id ? { finding_id: input.finding_id } : {}),
      ...(input.proposed_by ? { proposed_by: input.proposed_by } : {}),
      ...(input.reverts ? { reverts: input.reverts } : {}),
      ...(input.reproposes ? { reproposes: input.reproposes } : {}),
      status: 'proposed',
      history: [],
    };
  }

  /** The proposal, its diff against its base, and whether it can still be applied. */
  showProposal(id: string): { proposal: Proposal & { result_commit?: string }; diff: string; applicable: boolean } {
    const proposal = this.proposals.get(id);
    if (!proposal) throw new Error(`unknown proposal: ${id}`);
    const base = this.git.showAt(proposal.base_revision, proposal.file);
    if (base === null) throw new Error(`${proposal.file} not found at revision ${proposal.base_revision}`);
    const diff = this.git.diffTexts(
      base,
      applyChange(base, proposal.find, proposal.replace),
      `${proposal.file} @ ${proposal.base_revision.slice(0, 10)}`,
      `${proposal.file} (proposed)`,
    );
    const resultCommit = proposal.status === 'accepted' ? this.git.commitWithSubject(acceptSubject(id)) : null;
    return {
      proposal: { ...proposal, ...(resultCommit ? { result_commit: resultCommit } : {}) },
      diff,
      applicable: proposal.status === 'proposed' && this.git.blobOf(proposal.file) === proposal.base_blob,
    };
  }

  /**
   * The only path that changes a scene, and only after an explicit human accept.
   * Text and decision go in one commit, so neither can exist without the other.
   */
  reviewProposal(id: string, decision: Decision, by: string, note?: string, expected?: number): { proposal: Proposal; changed: boolean } {
    const proposal = this.proposals.get(id);
    if (!proposal) throw new Error(`unknown proposal: ${id}`);
    checkExpected(proposal.status, proposal.history, decision, expected);
    const next = nextEditorialStatus(proposal.status, decision);
    if (next === null) return { proposal, changed: false };
    proposal.history.push({ at: new Date().toISOString(), by, from: proposal.status, to: next, ...(note ? { note } : {}) });
    proposal.status = next;

    if (decision === 'reject') {
      this.saveRecords(`rewrite: reject ${id}`, [['proposals', id]], () => this.proposals.put(id, proposal));
      return { proposal, changed: true };
    }

    const path = join(this.dir, proposal.file);
    const current = this.readScene(proposal.file);
    if (current === null || this.git.blobOf(proposal.file) !== proposal.base_blob) {
      throw new Error(`${proposal.file} changed since proposal ${id} was made; nothing was written`);
    }
    this.commitWrites(acceptSubject(id), [proposal.file, recordPath('proposals', id)], () => {
      writeFileSync(path, applyChange(current, proposal.find, proposal.replace));
      this.proposals.put(id, proposal);
    });
    return { proposal, changed: true };
  }

  /**
   * A person takes back a rejection: the proposal is proposed again and the text does not move. If
   * the scene changed meanwhile the proposal stays not applicable, as any stale proposal. An accepted
   * proposal already changed the text, so it is never reopened: it is reverted through a new proposal.
   */
  reopenProposal(id: string, by: string, expected: number, note?: string): { proposal: Proposal; changed: boolean } {
    const proposal = this.proposals.get(id);
    if (!proposal) throw new Error(`unknown proposal: ${id}`);
    const transition = reopenTransition(proposal.status, proposal.history, expected);
    if (transition === 'unchanged') return { proposal, changed: false };
    if (proposal.status === 'accepted') throw new Error(`${id} already changed the text; revert it instead of reopening it`);
    proposal.history.push({ at: new Date().toISOString(), by, from: proposal.status, to: 'proposed', ...(note ? { note } : {}), action: 'reopen' });
    proposal.status = 'proposed';
    this.saveRecords(`rewrite: reopen ${id}`, [['proposals', id]], () => this.proposals.put(id, proposal));
    return { proposal, changed: true };
  }

  /**
   * Starts undoing an accepted text change. It writes no text: it creates the inverse proposal (the
   * changed passage back to what it was, against the current text), which changes the scene only
   * when a person accepts it. The accepted proposal stays accepted and its history records who
   * asked for the revert and which proposal undoes it. Refused when later edits touched the passage.
   * A repeated click returns the same inverse proposal; a rejected inverse proposal is reopened.
   */
  revertProposal(id: string, by: string, expected: number, note?: string): { proposal: Proposal; created: boolean } {
    const proposal = this.proposals.get(id);
    if (!proposal) throw new Error(`unknown proposal: ${id}`);
    if (proposal.status !== 'accepted') throw new Error(`only an accepted proposal can be reverted; ${id} is ${proposal.status}`);
    const last = proposal.history.at(-1);
    if (proposal.history.length === expected + 1 && last?.action === 'revert' && last.ref) {
      const linked = this.proposals.get(last.ref);
      if (linked?.status === 'proposed') return { proposal: linked, created: false };
    }
    if (proposal.history.length !== expected) throw new StaleStateError();

    const current = this.readScene(proposal.file);
    if (current === null) throw new Error(`scene not found: ${proposal.file}`);
    if (this.git.isDirty(proposal.file)) throw new Error(`${proposal.file} has uncommitted edits; commit them before reverting a change`);
    const base = this.git.showAt(proposal.base_revision, proposal.file);
    const change = base === null ? null : inverseChange(base, proposal.find, proposal.replace, current);
    if (change === null) {
      throw new Error('Hay ediciones posteriores que tocan este pasaje, así que no se puede revertir automáticamente. Revísalo a mano con una propuesta nueva.');
    }
    const built = this.buildProposal({ file: proposal.file, ...change, rationale: `Revert ${id}`, proposed_by: by, reverts: id });
    const existing = this.proposals.get(built.proposal_id);
    const at = new Date().toISOString();
    const inverse = existing ?? built;
    if (inverse.status === 'rejected') {
      inverse.history.push({ at, by, from: 'rejected', to: 'proposed', action: 'reopen', ref: id });
      inverse.status = 'proposed';
    }
    proposal.history.push({ at, by, from: 'accepted', to: 'accepted', ...(note ? { note } : {}), action: 'revert', ref: inverse.proposal_id });
    this.saveRecords(`rewrite: propose ${inverse.proposal_id} to revert ${id}`, [['proposals', inverse.proposal_id], ['proposals', id]], () => {
      this.proposals.put(inverse.proposal_id, inverse);
      this.proposals.put(id, proposal);
    });
    return { proposal: inverse, created: existing === null };
  }

  /**
   * Proposes the change of an earlier proposal again, against the current text: after it was
   * reverted, or when it went stale. The new proposal goes through review like any other.
   */
  reproposeRevision(id: string, by: string): { proposal: Proposal; created: boolean } {
    const proposal = this.proposals.get(id);
    if (!proposal) throw new Error(`unknown proposal: ${id}`);
    const findingStillThere = proposal.finding_id && this.check().some((f) => f.finding_id === proposal.finding_id);
    const built = this.buildProposal({
      file: proposal.file,
      find: proposal.find,
      replace: proposal.replace,
      rationale: proposal.rationale,
      ...(findingStillThere ? { finding_id: proposal.finding_id } : {}),
      proposed_by: by,
      reproposes: id,
    });
    const existing = this.proposals.get(built.proposal_id);
    if (existing) return { proposal: existing, created: false };
    this.saveRecords(`rewrite: propose ${built.proposal_id} again from ${id}`, [['proposals', built.proposal_id]], () => this.proposals.put(built.proposal_id, built));
    return { proposal: built, created: true };
  }
}

interface ProposalInput {
  file: string;
  find: string;
  replace: string;
  rationale: string;
  finding_id?: string;
  proposed_by?: string;
  reverts?: string;
  reproposes?: string;
}

/**
 * An accept or reject may carry the history length the person saw. A different length means another
 * tab or person changed the item since, unless it is this same decision already recorded (a repeat).
 */
function checkExpected(status: string, history: { length: number }, decision: Decision, expected: number | undefined): void {
  if (expected === undefined || history.length === expected) return;
  const target = decision === 'accept' ? 'accepted' : 'rejected';
  if (history.length === expected + 1 && status === target) return;
  throw new StaleStateError();
}

/** Where a stored record lives, relative to the book repository. */
function recordPath(collection: string, id: string): string {
  return join(STATE_DIR, collection, `${id}.json`);
}

function acceptSubject(id: string): string {
  return `rewrite: accept ${id}`;
}
