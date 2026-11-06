import { cpSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { parsePin, targetPath } from '../src/hcs/pin.ts';

function run(): void {
  const root = resolve(import.meta.dirname, '..');
  let contents: string;
  try { contents = readFileSync(join(root, 'hcs.pin.json'), 'utf8'); }
  catch { throw new Error('HCS pin is missing or unreadable: hcs.pin.json'); }
  const pin = parsePin(contents);
  const target = targetPath(root, pin);
  if (existsSync(join(target, '.complete'))) {
    console.log(`HCS ${pin.commit} is already fetched`);
    return;
  }
  let temporary: string | undefined;
  try {
    let source = process.env.HCS_SOURCE_DIR;
    if (!source) {
      temporary = mkdtempSync(join(tmpdir(), 'rewrite-hcs-'));
      source = join(temporary, 'source');
      try { execFileSync('gh', ['repo', 'clone', pin.repository, source], { stdio: 'pipe' }); }
      catch { throw new Error('Unable to clone HCS; check gh is installed and authenticated with access to the repository'); }
      try { execFileSync('git', ['-C', source, 'checkout', '--detach', pin.commit], { stdio: 'pipe' }); }
      catch { throw new Error(`Unable to check out pinned HCS commit ${pin.commit}`); }
    }
    let actual: string;
    try { actual = execFileSync('git', ['-C', source, 'rev-parse', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim(); }
    catch { throw new Error('HCS source is not a readable git checkout'); }
    if (actual !== pin.commit) throw new Error(`HCS commit mismatch: expected ${pin.commit}, got ${actual}`);
    mkdirSync(target, { recursive: true });
    for (const dir of ['schemas', 'requirements', 'conformance']) {
      cpSync(join(source, dir), join(target, dir), { recursive: true, force: true });
    }
    writeFileSync(join(target, '.complete'), `${pin.commit}\n`);
    console.log(`Fetched HCS ${pin.commit} into ${target}`);
  } finally {
    if (temporary) rmSync(temporary, { recursive: true, force: true });
  }
}

try { run(); } catch (error) {
  console.error(`HCS fetch failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
