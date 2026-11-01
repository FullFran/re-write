#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { ANNOTATION_EXTRACTOR, loadAnnotations } from '../adapters/annotation-extractor.ts';
import { Library } from '../application/library.ts';
import { Project, reviewer } from '../application/project.ts';
import type { ClaimView, Decision } from '../domain/claim.ts';
import { VERDICTS, type Finding, type VerdictKind } from '../domain/continuity.ts';

const USAGE = `RE;write: narrative memory with evidence and human review.

  rewrite init <dir> [--title <title>]       create or open a book repository
  rewrite import <dir> <scene.md>...         copy scenes in and commit them
  rewrite read <dir> <scenes/file.md>        print a scene
  rewrite extract <dir> --from <file.json>   load candidate claims and verify their quotes
  rewrite claims <dir>                       list claims and their evidence
  rewrite review-claim <dir> <id> accept|reject [--by <name>] [--note <text>]
  rewrite canon <dir>                        list accepted facts with valid evidence
  rewrite check <dir>                        look for knowledge-order problems (rules, no LLM)
  rewrite review-finding <dir> <id> confirmed|deliberate_mystery|false_positive [--by] [--note]
  rewrite propose <dir> --file <scenes/f.md> --find <text> --replace <text> --rationale <text> [--finding <id>]
  rewrite show <dir> <proposal-id>           show a proposal and its diff
  rewrite review-proposal <dir> <id> accept|reject [--by <name>] [--note <text>]
  rewrite status <dir>                       show the restored project state
  rewrite grant <data-dir> <book> <user-id>  give a person access to a book on a server

Add --json to any command for machine-readable output.`;

class UsageError extends Error {}

function need(value: string | undefined, name: string): string {
  if (!value) throw new UsageError(`missing ${name}`);
  return value;
}

function decisionOf(value: string | undefined): Decision {
  if (value !== 'accept' && value !== 'reject') throw new UsageError('decision must be accept or reject');
  return value;
}

function formatClaim(c: ClaimView): string {
  const lines = [
    `${c.claim_id}  [${c.editorial_status}] [${c.epistemic_kind}] evidence: ${c.evidence_status} (${c.evidence_reason})`,
    `  ${c.statement}`,
    `  «${c.anchor.quote}»`,
    `  ${c.source_file} @ ${c.revision.slice(0, 10)}  scope: ${c.scope}  extractor: ${c.extractor}`,
  ];
  if (c.uncertainty) lines.push(`  uncertainty: ${c.uncertainty}`);
  return lines.join('\n');
}

function formatFinding(f: Finding): string {
  const citations = f.citations.map((c) =>
    `  «${c.quote}»\n    ${c.source_file} @ ${c.revision.slice(0, 10)}  story time: ${c.story_time ?? 'unknown'}  reading order: ${c.reveal_order ?? 'unknown'}  evidence: ${c.evidence_status}`);
  return [
    `${f.finding_id}  ${f.classification}  (heuristic ${f.method}, not a verdict)`,
    `  ${f.explanation}`,
    ...citations,
    '  Other readings:',
    ...f.alternatives.map((a) => `    - ${a}`),
    `  Human verdict: ${f.verdict ? `${f.verdict.verdict} (${f.verdict.by})` : 'none yet'}`,
  ].join('\n');
}

function statusOf(project: Project): object {
  return {
    title: project.title(),
    head: project.git.head(),
    scenes: project.scenes(),
    claims: project.claimViews().map(({ claim_id, editorial_status, evidence_status }) =>
      ({ claim_id, editorial_status, evidence_status })),
    findings: project.check().map(({ finding_id, classification, verdict }) =>
      ({ finding_id, classification, verdict: verdict?.verdict ?? null })),
    proposals: project.proposals.all().map(({ proposal_id, file, status }) => ({ proposal_id, file, status })),
  };
}

interface Output {
  json: unknown;
  text: string;
}

function dispatch(args: string[], values: Record<string, string | boolean | undefined>): Output {
  const [command, dir, ...rest] = args;
  const option = (name: string) => values[name] as string | undefined;
  switch (command) {
    case 'init': {
      const { project, created } = Project.init(need(dir, '<dir>'), option('title') ?? 'Untitled book');
      return { json: { dir: project.dir, created }, text: `${created ? 'created' : 'opened'} ${project.dir}` };
    }
    case 'import': {
      if (!rest.length) throw new UsageError('missing <scene.md>');
      const result = Project.open(need(dir, '<dir>')).importScenes(rest);
      return { json: result, text: `imported: ${result.imported.join(', ') || 'none'}; unchanged: ${result.unchanged.join(', ') || 'none'}` };
    }
    case 'read': {
      const file = need(rest[0], '<scenes/file.md>');
      const text = Project.open(need(dir, '<dir>')).readScene(file);
      if (text === null) throw new Error(`scene not found: ${file}`);
      return { json: { file, text }, text };
    }
    case 'extract': {
      const extraction = loadAnnotations(need(option('from'), '--from'));
      const result = Project.open(need(dir, '<dir>')).extractClaims(extraction);
      const rejected = result.rejected.map((r) => `\n  rejected: ${r.statement} (${r.reason})`).join('');
      return {
        json: { extractor: extraction.extractor, ...result },
        text: `extractor: ${extraction.extractor}${extraction.extractor === ANNOTATION_EXTRACTOR ? ' (hand annotations, no LLM)' : ''}\ncreated: ${result.created.length}; existing: ${result.existing.length}; rejected: ${result.rejected.length}${rejected}`,
      };
    }
    case 'claims': {
      const claims = Project.open(need(dir, '<dir>')).claimViews();
      return { json: { claims }, text: claims.map(formatClaim).join('\n\n') || 'no claims' };
    }
    case 'review-claim': {
      const id = need(rest[0], '<id>');
      const result = Project.open(need(dir, '<dir>')).reviewClaim(id, decisionOf(rest[1]), reviewer(option('by')), option('note'));
      return { json: result, text: `${result.changed ? 'recorded' : 'no change'}: ${id} is ${result.claim.editorial_status}` };
    }
    case 'canon': {
      const canon = Project.open(need(dir, '<dir>')).canon();
      return { json: { canon }, text: canon.map(formatClaim).join('\n\n') || 'canon is empty' };
    }
    case 'check': {
      const findings = Project.open(need(dir, '<dir>')).check();
      return { json: { findings }, text: findings.map(formatFinding).join('\n\n') || 'no findings (this is not proof of consistency)' };
    }
    case 'review-finding': {
      const id = need(rest[0], '<id>');
      const verdict = rest[1] as VerdictKind;
      if (!VERDICTS.includes(verdict)) throw new UsageError(`verdict must be one of: ${VERDICTS.join(', ')}`);
      const record = Project.open(need(dir, '<dir>')).reviewFinding(id, verdict, reviewer(option('by')), option('note'));
      return { json: record, text: `recorded: ${id} is ${verdict}` };
    }
    case 'propose': {
      const project = Project.open(need(dir, '<dir>'));
      const result = project.proposeRevision({
        file: need(option('file'), '--file'),
        find: need(option('find'), '--find'),
        replace: need(option('replace'), '--replace'),
        rationale: need(option('rationale'), '--rationale'),
        finding_id: option('finding'),
      });
      const label = result.created ? 'created' : `already exists (${result.proposal.status})`;
      return { json: result, text: `${label}: ${result.proposal.proposal_id}\n\n${project.showProposal(result.proposal.proposal_id).diff}` };
    }
    case 'show': {
      const id = need(rest[0], '<id>');
      const shown = Project.open(need(dir, '<dir>')).showProposal(id);
      const p = shown.proposal;
      const lines = [
        `${p.proposal_id}  [${p.status}]${shown.applicable ? '' : p.status === 'proposed' ? '  NOT APPLICABLE: the scene changed since' : ''}`,
        `rationale: ${p.rationale}`,
        ...(p.finding_id ? [`finding: ${p.finding_id}`] : []),
        ...(p.result_commit ? [`new version: ${p.result_commit}`] : []),
        ...p.history.map((h) => `decision: ${h.to} by ${h.by} at ${h.at}${h.note ? ` (${h.note})` : ''}`),
        '',
        shown.diff,
      ];
      return { json: shown, text: lines.join('\n') };
    }
    case 'review-proposal': {
      const id = need(rest[0], '<id>');
      const project = Project.open(need(dir, '<dir>'));
      const result = project.reviewProposal(id, decisionOf(rest[1]), reviewer(option('by')), option('note'));
      const commit = project.showProposal(id).proposal.result_commit;
      return {
        json: result,
        text: `${result.changed ? 'recorded' : 'no change'}: ${id} is ${result.proposal.status}${commit ? `; new version ${commit}` : '; the text was not changed'}`,
      };
    }
    case 'grant': {
      const [book, subject] = rest;
      new Library(need(dir, '<data-dir>')).grant(need(book, '<book>'), need(subject, '<user-id>'));
      return { json: { book, subject }, text: `granted ${subject} access to ${book}` };
    }
    case 'status': {
      const status = statusOf(Project.open(need(dir, '<dir>')));
      return { json: status, text: JSON.stringify(status, null, 2) };
    }
    default:
      throw new UsageError(command ? `unknown command: ${command}` : 'missing command');
  }
}

function main(): number {
  let parsed;
  try {
    parsed = parseArgs({
      allowPositionals: true,
      options: {
        json: { type: 'boolean' }, title: { type: 'string' }, from: { type: 'string' },
        by: { type: 'string' }, note: { type: 'string' }, file: { type: 'string' }, find: { type: 'string' },
        replace: { type: 'string' }, rationale: { type: 'string' }, finding: { type: 'string' },
      },
    });
  } catch (error) {
    console.error(`usage error: ${(error as Error).message}\n\n${USAGE}`);
    return 2;
  }
  try {
    const output = dispatch(parsed.positionals, parsed.values);
    console.log(parsed.values.json ? JSON.stringify(output.json, null, 2) : output.text);
    return 0;
  } catch (error) {
    if (error instanceof UsageError) {
      console.error(`usage error: ${error.message}\n\n${USAGE}`);
      return 2;
    }
    console.error(`error: ${(error as Error).message}`);
    return 1;
  }
}

process.exitCode = main();
