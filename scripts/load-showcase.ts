/**
 * Loads the showcase book (fixtures/la-puerta-de-sal, docs/showcase.md) into a local data
 * directory, through the product's own application layer and nothing else:
 *
 *   1. creates the book repository (Project.init) and imports the twenty scenes;
 *   2. proposes each note and accepts the proposal, the path any new note takes;
 *   3. extracts the claim candidates from annotations.json, verifying every quote, and accepts the
 *      narrated facts, so Canon has content while beliefs and rumours wait in the review queue;
 *   4. with --user, gives that person access to the book.
 *
 * It writes only inside the data directory it is given, and refuses a book that already exists, so
 * it never changes a book someone has worked on. Loading production is a separate decision.
 *
 *   node scripts/load-showcase.ts <data-dir> [--book <id>] [--user <subject>] [--json]
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { loadAnnotations } from '../src/adapters/annotation-extractor.ts';
import { BOOK_ID, Library } from '../src/application/library.ts';
import { Project } from '../src/application/project.ts';

export const SHOWCASE = resolve(import.meta.dirname, '../fixtures/la-puerta-de-sal');
export const SHOWCASE_TITLE = 'La puerta de Sal';
export const LOADER = 'showcase-loader';

export interface ShowcaseLoad {
  book: string;
  dir: string;
  scenes: string[];
  notes: string[];
  claims: { created: number; accepted: number; proposed: number; rejected: { statement: string; reason: string }[] };
  user: string | null;
}

export function loadShowcase(dataDir: string, options: { book?: string; user?: string } = {}): ShowcaseLoad {
  const book = options.book ?? 'la-puerta-de-sal';
  if (!BOOK_ID.test(book)) throw new Error(`invalid book id: ${book} (lower-case letters, digits and dashes)`);
  const dir = join(resolve(dataDir), 'books', book);
  if (existsSync(dir)) throw new Error(`${dir} already exists; the showcase is loaded only into a new book`);

  const { project } = Project.init(dir, SHOWCASE_TITLE);
  const scenesDir = join(SHOWCASE, 'scenes');
  const { imported } = project.importScenes(readdirSync(scenesDir).filter((f) => f.endsWith('.md')).sort().map((f) => join(scenesDir, f)));

  const notesDir = join(SHOWCASE, 'notas');
  const notes = readdirSync(notesDir).filter((f) => f.endsWith('.md')).sort().map((f) => f.slice(0, -3));
  for (const name of notes) {
    const text = readFileSync(join(notesDir, `${name}.md`), 'utf8');
    const { proposal } = project.proposeNote({ name, text, rationale: 'Ficha del libro de muestra', proposed_by: LOADER });
    project.reviewProposal(proposal.proposal_id, 'accept', LOADER, 'Cargada con el libro de muestra');
  }

  const extraction = project.extractClaims(loadAnnotations(join(SHOWCASE, 'annotations.json')), LOADER);
  let accepted = 0;
  for (const claim of project.claimViews()) {
    if (claim.epistemic_kind !== 'narrated_fact') continue;
    project.reviewClaim(claim.claim_id, 'accept', LOADER, 'Hecho narrado del libro de muestra');
    accepted += 1;
  }

  if (options.user) new Library(dataDir).grant(book, options.user);
  return {
    book,
    dir,
    scenes: imported,
    notes: project.notes(),
    claims: { created: extraction.created.length, accepted, proposed: extraction.created.length - accepted, rejected: extraction.rejected },
    user: options.user ?? null,
  };
}

function main(): void {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: { book: { type: 'string' }, user: { type: 'string' }, json: { type: 'boolean' } },
  });
  if (positionals.length !== 1) {
    process.stderr.write('usage: node scripts/load-showcase.ts <data-dir> [--book <id>] [--user <subject>] [--json]\n');
    process.exit(2);
  }
  try {
    const result = loadShowcase(positionals[0], { book: values.book, user: values.user });
    if (values.json) process.stdout.write(`${JSON.stringify(result)}\n`);
    else {
      process.stdout.write([
        `loaded "${SHOWCASE_TITLE}" as ${result.book} in ${result.dir}`,
        `  scenes: ${result.scenes.length}, notes: ${result.notes.length}`,
        `  claims: ${result.claims.created} (${result.claims.accepted} accepted, ${result.claims.proposed} waiting for review)`,
        result.user ? `  access: ${result.user}` : '  access: nobody yet (pass --user <subject>)',
        '',
      ].join('\n'));
    }
    if (result.claims.rejected.length) {
      process.stderr.write(`${JSON.stringify({ rejected: result.claims.rejected })}\n`);
      process.exit(1);
    }
  } catch (error) {
    process.stderr.write(`${JSON.stringify({ error: (error as Error).message })}\n`);
    process.exit(1);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
