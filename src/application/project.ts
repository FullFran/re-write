import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, join, normalize, resolve } from 'node:path';
import { Git } from '../adapters/git.ts';
import { JsonStore, STATE_DIR } from '../adapters/json-store.ts';
import type { Extraction } from '../adapters/annotation-extractor.ts';
import { assessAnchor, buildAnchor, matchesRevision } from '../domain/anchor.ts';
import {
  claimId, EPISTEMIC_KINDS, isCanon, nextEditorialStatus,
  type Claim, type ClaimCandidate, type ClaimView, type Decision,
} from '../domain/claim.ts';
import { inspectContinuity, type Finding, type Verdict, type VerdictKind } from '../domain/continuity.ts';
import { applyChange, proposalId, type Proposal } from '../domain/proposal.ts';
import {
  findingId, viewFinding,
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
    manifest.put('project', { title });
    project.git.commit(`rewrite: create project ${title}`, [STATE_DIR]);
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
    const imported: string[] = [];
    const unchanged: string[] = [];
    for (const file of files) {
      const relative = `${SCENES_DIR}/${basename(file)}`;
      const target = join(this.dir, relative);
      if (existsSync(target)) {
        if (readFileSync(target, 'utf8') !== readFileSync(file, 'utf8')) {
          throw new Error(`${relative} already exists with different text; edit it through a proposal`);
        }
        unchanged.push(relative);
        continue;
      }
      mkdirSync(join(this.dir, SCENES_DIR), { recursive: true });
      copyFileSync(file, target);
      imported.push(relative);
    }
    if (imported.length) this.git.commit(`rewrite: import ${imported.join(', ')}`, imported);
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
    for (const candidate of extraction.candidates) {
      try {
        const id = claimId(candidate);
        if (this.claims.get(id)) {
          existing.push(id);
          continue;
        }
        const claim = this.buildClaim(id, candidate, revision, extraction.extractor);
        this.claims.put(id, proposedBy ? { ...claim, proposed_by: proposedBy } : claim);
        created.push(id);
      } catch (error) {
        rejected.push({ statement: candidate.statement, reason: (error as Error).message });
      }
    }
    if (created.length) this.git.commit(`rewrite: extract ${created.length} claims`, [STATE_DIR]);
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

  reviewClaim(id: string, decision: Decision, by: string, note?: string): { claim: ClaimView; changed: boolean } {
    const claim = this.claims.get(id);
    if (!claim) throw new Error(`unknown claim: ${id}`);
    const next = nextEditorialStatus(claim.editorial_status, decision);
    if (next === null) return { claim: this.view(claim), changed: false };
    const current = this.view(claim);
    if (decision === 'accept' && current.evidence_status !== 'valid') {
      throw new Error(`cannot accept ${id}: evidence is ${current.evidence_status} (${current.evidence_reason})`);
    }
    claim.history.push({ at: new Date().toISOString(), by, from: claim.editorial_status, to: next, ...(note ? { note } : {}) });
    claim.editorial_status = next;
    this.claims.put(id, claim);
    this.git.commit(`rewrite: ${decision} claim ${id}`, [STATE_DIR]);
    return { claim: this.view(claim), changed: true };
  }

  /** Everything a reviewer needs for one book, recomputed from the text on each read. */
  reviewQueue(): { claims: ClaimView[]; canon: ClaimView[]; findings: Finding[]; proposals: ReturnType<Project['showProposal']>[] } {
    return {
      claims: this.claimViews(),
      canon: this.canon(),
      findings: this.check(),
      proposals: this.proposals.all().map((p) => this.showProposal(p.proposal_id)),
    };
  }

  /** Read-only: it computes findings and attaches any verdict a human already gave. */
  check(): Finding[] {
    return inspectContinuity(this.claimViews()).map((finding) => {
      const verdict = this.verdicts.get(finding.finding_id);
      return verdict ? { ...finding, verdict } : finding;
    });
  }

  reviewFinding(id: string, verdict: VerdictKind, by: string, note?: string): Verdict {
    if (!this.check().some((finding) => finding.finding_id === id)) throw new Error(`unknown finding: ${id}`);
    const record: Verdict = { finding_id: id, verdict, by, at: new Date().toISOString(), ...(note ? { note } : {}) };
    this.verdicts.put(id, record);
    this.git.commit(`rewrite: ${verdict} finding ${id}`, [STATE_DIR]);
    return record;
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

    for (const candidate of candidates) {
      const id = findingId(candidate);
      if (this.findings.get(id)) {
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
      this.findings.put(id, record);
      created.push(id);
    }

    if (created.length) this.git.commit(`rewrite: propose ${created.length} findings`, [STATE_DIR]);
    return { created, existing, findings: this.findingViews() };
  }

  findingViews(): FindingView[] {
    return this.findings.all().map((f) => {
      const view = viewFinding(
        f,
        (file) => this.readScene(file),
        (rev, file) => this.git.showAt(rev, file),
      );
      const verdict = this.verdicts.get(f.finding_id);
      return verdict ? { ...view, verdict } : view;
    });
  }

  /** Stores a change for review. It never writes to the scene. */
  proposeRevision(input: { file: string; find: string; replace: string; rationale: string; finding_id?: string; proposed_by?: string }):
    { proposal: Proposal; created: boolean } {
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
    const id = proposalId(file, baseBlob, input.find, input.replace);
    const existing = this.proposals.get(id);
    if (existing) return { proposal: existing, created: false };
    const proposal: Proposal = {
      proposal_id: id,
      file,
      base_revision: this.git.head(),
      base_blob: baseBlob,
      find: input.find,
      replace: input.replace,
      rationale: input.rationale,
      ...(input.finding_id ? { finding_id: input.finding_id } : {}),
      ...(input.proposed_by ? { proposed_by: input.proposed_by } : {}),
      status: 'proposed',
      history: [],
    };
    this.proposals.put(id, proposal);
    this.git.commit(`rewrite: propose ${id}`, [STATE_DIR]);
    return { proposal, created: true };
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
  reviewProposal(id: string, decision: Decision, by: string, note?: string): { proposal: Proposal; changed: boolean } {
    const proposal = this.proposals.get(id);
    if (!proposal) throw new Error(`unknown proposal: ${id}`);
    const next = nextEditorialStatus(proposal.status, decision);
    if (next === null) return { proposal, changed: false };
    const previous = structuredClone(proposal);
    proposal.history.push({ at: new Date().toISOString(), by, from: proposal.status, to: next, ...(note ? { note } : {}) });
    proposal.status = next;

    if (decision === 'reject') {
      this.proposals.put(id, proposal);
      this.git.commit(`rewrite: reject ${id}`, [STATE_DIR]);
      return { proposal, changed: true };
    }

    const path = join(this.dir, proposal.file);
    const current = this.readScene(proposal.file);
    if (current === null || this.git.blobOf(proposal.file) !== proposal.base_blob) {
      throw new Error(`${proposal.file} changed since proposal ${id} was made; nothing was written`);
    }
    try {
      writeFileSync(path, applyChange(current, proposal.find, proposal.replace));
      this.proposals.put(id, proposal);
      this.git.commit(acceptSubject(id), [proposal.file, STATE_DIR]);
    } catch (error) {
      writeFileSync(path, current);
      this.proposals.put(id, previous);
      throw error;
    }
    return { proposal, changed: true };
  }
}

function acceptSubject(id: string): string {
  return `rewrite: accept ${id}`;
}
