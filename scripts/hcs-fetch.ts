import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parsePin } from '../src/hcs/pin.ts';
import { fetchHcs } from '../src/hcs/fetch.ts';

function run(): void {
  const root = resolve(import.meta.dirname, '..');
  let contents: string;
  try { contents = readFileSync(join(root, 'hcs.pin.json'), 'utf8'); }
  catch { throw new Error('HCS pin is missing or unreadable: hcs.pin.json'); }
  console.log(fetchHcs(root, parsePin(contents), { source: process.env.HCS_SOURCE_DIR }));
}

try { run(); } catch (error) {
  console.error(`HCS fetch failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
