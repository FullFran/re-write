#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { buildPackage } from '../hcs/package.ts';
import { fileURLToPath } from 'node:url';
import { HcsFailure } from '../hcs/errors.ts';
import { readCatalog } from '../hcs/catalog.ts';
import { activeGeneration, applyDesiredSet, statusReport } from '../hcs/host-state.ts';
import { grantPermission, revokePermission } from '../hcs/grants.ts';
import type { EntryStatus } from '../hcs/lifecycle.ts';
import { productProblem, rejectedCandidate } from '../adapters/problems.ts';
import { ANNOTATION_EXTRACTOR, loadAnnotations } from '../adapters/annotation-extractor.ts';
import { Library } from '../application/library.ts';
import { Project, reviewer } from '../application/project.ts';
import type { ClaimView, Decision } from '../domain/claim.ts';
import { VERDICTS, type Finding, type VerdictKind } from '../domain/continuity.ts';

const USAGE = `RE;write: narrative memory with evidence and human review.

  rewrite package <dir> [--out <file>] [--json]  build a deterministic package archive
  rewrite catalog validate <catalog.json>    check a catalog document
  rewrite catalog apply <catalog.json> --state <dir> [--store <dir>] [--grants <data-dir>]
                                             install a catalog as a new generation (runs no package code);
                                             each entry needs a grant for every permission it requests
  rewrite catalog status --state <dir>       show the active generation and entry states
  rewrite init <dir> [--title <title>]       create or open a book repository
  rewrite import <dir> <scene.md>...         copy scenes in and commit them
  rewrite notion-inspect <export.zip|dir>    inspect Notion export databases and pages safely
  rewrite import-notion <dir> <export.zip|dir> --mapping <mapping.json> [--dry-run]
                                             import chapters from a Notion export via mapping
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
  rewrite revoke <data-dir> <book> <user-id> remove a person's access to a book; applies to their next call
  rewrite package-grant <data-dir> <entry> <permission>
                                             grant a permission to a package entry (never review decisions)
  rewrite package-revoke <data-dir> <entry> <permission>
                                             revoke it; applies to the next operation

Add --json to any command for machine-readable output. Failures are JSON on stderr.`;

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

function lifecycleOutput(generation: number | null, entries: EntryStatus[]): Output {
  const lines = entries.map(e => `  ${e.entry} ${e.version} ${e.state}${e.error ? ` (${e.error.code}: ${e.error.message})` : ''}`);
  return { json: { generation, entries }, text: [`generation ${generation ?? 'none'}`, ...lines].join('\n') };
}

async function catalogCommand(sub: string | undefined, rest: string[], option: (name: string) => string | undefined): Promise<Output> {
  if (sub === 'status') {
    if (rest.length) throw new UsageError('unexpected catalog status arguments');
    const stateDir = need(option('state'), '--state');
    return lifecycleOutput(activeGeneration(stateDir), statusReport(stateDir));
  }
  if (sub !== 'validate' && sub !== 'apply') throw new UsageError(sub ? `unknown catalog command: ${sub}` : 'missing catalog command');
  const file = need(rest[0], '<catalog.json>');
  if (rest.length > 1) throw new UsageError(`unexpected catalog ${sub} arguments`);
  if (sub === 'apply') {
    const stateDir = need(option('state'), '--state');
    const result = await applyDesiredSet(readFileSync(file), { stateDir, storeDir: option('store'), grantsDir: option('grants') });
    return lifecycleOutput(result.generation, result.status);
  }
  const read = readCatalog(readFileSync(file));
  if (!read.ok) throw new HcsFailure(read.errors);
  const { id, version, entries } = read.catalog;
  return { json: { valid: true, id, version, entries: entries.length }, text: `valid: ${id} ${version} (${entries.length} entries)` };
}

interface Output {
  json: unknown;
  text: string;
}

async function dispatch(args: string[], values: Record<string, string | boolean | undefined>): Promise<Output> {
  const [command, dir, ...rest] = args;
  const option = (name: string) => values[name] as string | undefined;
  switch (command) {
    case 'package': {
      const source = need(dir, '<dir>');
      if (rest.length) throw new UsageError('unexpected package arguments');
      const file = option('out') ?? `${basename(resolve(source))}.tar.gz`;
      const { bytes, contentHash, size, mediaType } = buildPackage(source);
      writeFileSync(file, bytes);
      return { json: { contentHash, size, mediaType, file }, text: `${contentHash} ${size}` };
    }
    case 'catalog':
      return catalogCommand(dir, rest, option);
    case 'init': {
      const { project, created } = Project.init(need(dir, '<dir>'), option('title') ?? 'Untitled book');
      return { json: { dir: project.dir, created }, text: `${created ? 'created' : 'opened'} ${project.dir}` };
    }
    case 'import': {
      if (!rest.length) throw new UsageError('missing <scene.md>');
      const result = Project.open(need(dir, '<dir>')).importScenes(rest);
      return { json: result, text: `imported: ${result.imported.join(', ') || 'none'}; unchanged: ${result.unchanged.join(', ') || 'none'}` };
    }
    case 'notion-inspect': {
      const source = need(dir, '<export.zip|dir>');
      const { inspectNotion, formatNotionInspection } = await import('../application/notion-export.ts');
      const report = inspectNotion(source);
      return { json: report, text: formatNotionInspection(report) };
    }
    case 'import-notion': {
      const bookDir = need(dir, '<book-dir>');
      const source = need(rest[0], '<export.zip|dir>');
      const mappingFile = need(option('mapping'), '--mapping');
      const isDryRun = Boolean(values['dry-run']);
      const { parseNotionMapping } = await import('../application/notion-export.ts');
      const mapping = parseNotionMapping(JSON.parse(readFileSync(mappingFile, 'utf8')));
      const { loadNotionChapters } = await import('../application/notion-export.ts');
      const { importBook, chapterFilename, convertToMarkdown } = await import('../application/book-import.ts');
      const { chapters, missing } = loadNotionChapters(source, mapping);

      if (isDryRun) {
        const list = [
          ...chapters.map((c) => {
            const filename = chapterFilename(c.order, c.title);
            const converted = convertToMarkdown(c.body, c.format ?? 'markdown');
            return {
              order: c.order,
              title: c.title,
              file: `scenes/${filename}`,
              size: Buffer.byteLength(converted, 'utf8'),
              status: 'would_import',
            };
          }),
          ...missing.map((m) => ({
            order: m.order,
            title: m.title,
            file: m.file,
            size: 0,
            status: 'missing_page',
          })),
        ].sort((a, b) => a.order - b.order);

        const lines = [
          `dry run: ${chapters.length} chapter${chapters.length === 1 ? '' : 's'} in ${source}`,
          ...list.map((c) => `  [${String(c.order).padStart(3, '0')}] ${c.title} (${c.file}) - ${c.size} bytes${c.status === 'missing_page' ? ' [MISSING PAGE]' : ''}`),
        ];
        return {
          json: { dryRun: true, chapters: list },
          text: lines.join('\n'),
        };
      }

      const project = Project.open(bookDir);
      const result = importBook(project, chapters);
      for (const m of missing) {
        result.refused.push({
          order: m.order,
          title: m.title,
          file: m.file,
          reason: m.reason,
        });
      }
      const importedStr = result.imported.map((i) => i.file).join(', ') || 'none';
      const unchangedStr = result.unchanged.map((u) => u.file).join(', ') || 'none';
      const refusedStr = result.refused.map((r) => `${r.file} (${r.reason})`).join(', ') || 'none';
      return {
        json: result,
        text: `imported: ${importedStr}; unchanged: ${unchangedStr}; refused: ${refusedStr}`,
      };
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
        json: { extractor: extraction.extractor, ...result, rejected: result.rejected.map(rejectedCandidate) },
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
    case 'revoke': {
      const [book, subject] = rest;
      new Library(need(dir, '<data-dir>')).revoke(need(book, '<book>'), need(subject, '<user-id>'));
      return { json: { book, subject }, text: `revoked ${subject} access to ${book}` };
    }
    case 'package-grant':
    case 'package-revoke': {
      const [entry, permission] = rest;
      const data = need(dir, '<data-dir>');
      (command === 'package-grant' ? grantPermission : revokePermission)(data, need(entry, '<entry>'), need(permission, '<permission>'));
      return { json: { entry, permission }, text: `${command === 'package-grant' ? 'granted' : 'revoked'} ${permission} ${command === 'package-grant' ? 'to' : 'from'} ${entry}` };
    }
    case 'status': {
      const status = statusOf(Project.open(need(dir, '<dir>')));
      return { json: status, text: JSON.stringify(status, null, 2) };
    }
    default:
      throw new UsageError(command ? `unknown command: ${command}` : 'missing command');
  }
}

export function renderFailure(error: unknown, json: boolean, usage = false): { code: number; text: string } {
  const message = error instanceof Error ? error.message : String(error);
  const code = usage || error instanceof UsageError ? 2 : 1;
  if (json) return { code, text: JSON.stringify(error instanceof HcsFailure ? error.errors[0] : productProblem(message, code === 2 ? 400 : 409), null, 2) };
  return { code, text: code === 2 ? `usage error: ${message}\n\n${USAGE}` : `error: ${message}` };
}

async function main(): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      allowPositionals: true,
      options: {
        json: { type: 'boolean' }, out: { type: 'string' }, title: { type: 'string' }, from: { type: 'string' },
        by: { type: 'string' }, note: { type: 'string' }, file: { type: 'string' }, find: { type: 'string' },
        replace: { type: 'string' }, rationale: { type: 'string' }, finding: { type: 'string' },
        state: { type: 'string' }, store: { type: 'string' }, grants: { type: 'string' },
        mapping: { type: 'string' }, 'dry-run': { type: 'boolean' },
      },
    });
  } catch (error) {
    const failure = renderFailure(error, process.argv.includes('--json'), true);
    console.error(failure.text);
    return failure.code;
  }
  try {
    const output = await dispatch(parsed.positionals, parsed.values);
    console.log(parsed.values.json ? JSON.stringify(output.json, null, 2) : output.text);
    return 0;
  } catch (error) {
    const failure = renderFailure(error, Boolean(parsed.values.json));
    console.error(failure.text);
    return failure.code;
  }
}

// Run only as the entry point, also when invoked through a symlink such as node_modules/.bin/rewrite.
const entry = process.argv[1] ? realpathSync(process.argv[1]) : '';
if (entry === realpathSync(fileURLToPath(import.meta.url))) process.exitCode = await main();
