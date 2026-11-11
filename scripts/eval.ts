import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { compareRuns, formatTable, parseResults, resultRows, ROOT, runJourneys } from '../evals/runner.ts';

const USAGE = `Usage:
  npm run eval -- [--out <results.json>] [--journeys <dir>]
  npm run eval -- --compare <before.json> <after.json>

Runs the deterministic agent journeys in evals/journeys against this checkout, in memory, with no
model and no network. Exits 1 when a check fails, or when --compare finds a regression.`;

class UsageError extends Error {}

function load(file: string) {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    throw new UsageError(`cannot read ${file}: ${(error as Error).message}`);
  }
  try {
    return parseResults(raw, file);
  } catch (error) {
    throw new UsageError((error as Error).message);
  }
}

async function main(args: string[]): Promise<number> {
  if (args.includes('--help') || args.includes('-h')) {
    console.log(USAGE);
    return 0;
  }
  if (args[0] === '--compare') {
    if (args.length !== 3) throw new UsageError('--compare needs two results files');
    const before = load(args[1]);
    const after = load(args[2]);
    const comparison = compareRuns(before, after);
    console.log(`before: ${before.version} ${before.commit}${before.dirty ? ' (dirty)' : ''}`);
    console.log(`after:  ${after.version} ${after.commit}${after.dirty ? ' (dirty)' : ''}\n`);
    console.log(formatTable(comparison.rows));
    console.log(`\n${comparison.regressed} regressed, ${comparison.fixed} fixed, ${comparison.unchanged} unchanged, ${comparison.skipped} skipped`);
    return comparison.regressed > 0 ? 1 : 0;
  }
  let out = join(ROOT, 'evals', 'results', 'results.json');
  let dir: string | undefined;
  for (let index = 0; index < args.length; index += 2) {
    const value = args[index + 1];
    if (value === undefined || (args[index] !== '--out' && args[index] !== '--journeys')) {
      throw new UsageError(`unknown or incomplete option: ${args[index]}`);
    }
    if (args[index] === '--out') out = resolve(value);
    else dir = resolve(value);
  }
  let results;
  try {
    results = await runJourneys({ dir });
  } catch (error) {
    // Fail closed: a run that cannot start is a failure, never an empty success.
    console.error(`eval: ${(error as Error).message}`);
    return 1;
  }
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, `${JSON.stringify(results, null, 2)}\n`);
  console.log(formatTable(resultRows(results)));
  const { journeys, checks } = results.summary;
  console.log(`\njourneys: ${journeys.pass} passed, ${journeys.fail} failed; checks: ${checks.pass} passed, ${checks.fail} failed`);
  console.log(`results: ${out}`);
  return journeys.fail > 0 ? 1 : 0;
}

try {
  process.exitCode = await main(process.argv.slice(2));
} catch (error) {
  if (!(error instanceof UsageError)) throw error;
  console.error(`eval: ${error.message}\n\n${USAGE}`);
  process.exitCode = 2;
}
