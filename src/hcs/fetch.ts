import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { targetPath, type HcsPin } from './pin.ts';

export type CommandRunner = (command: string, args: string[]) => string;
export const runCommand: CommandRunner = (command, args) => execFileSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

function command(run: CommandRunner, executable: string, args: string[], message: string): string {
  try { return run(executable, args); }
  catch (error) {
    const stderr = error && typeof error === 'object' && 'stderr' in error ? String(error.stderr ?? '').trimEnd() : '';
    const tail = stderr.split(/\r?\n/).slice(-20).join('\n');
    throw new Error(`${message}${tail ? `\n${tail}` : ''}`);
  }
}

export function fetchHcs(root: string, pin: HcsPin, options: { source?: string; run?: CommandRunner } = {}): string {
  const run = options.run ?? runCommand;
  const target = targetPath(root, pin);
  if (existsSync(join(target, '.complete'))) return `HCS ${pin.commit} is already fetched`;
  if (existsSync(target)) rmSync(target, { recursive: true, force: true });
  let temporary: string | undefined;
  let partial: string | undefined;
  try {
    let source = options.source;
    if (!source) {
      temporary = mkdtempSync(join(tmpdir(), 'rewrite-hcs-'));
      source = join(temporary, 'source');
      command(run, 'gh', ['repo', 'clone', pin.repository, source], 'Unable to clone HCS; check gh is installed and authenticated with access to the repository');
      command(run, 'git', ['-C', source, 'checkout', '--detach', pin.commit], `Unable to check out pinned HCS commit ${pin.commit}`);
    }
    const actual = command(run, 'git', ['-C', source, 'rev-parse', 'HEAD'], 'HCS source is not a readable git checkout').trim();
    if (actual !== pin.commit) throw new Error(`HCS commit mismatch: expected ${pin.commit}, got ${actual}`);
    if (options.source && command(run, 'git', ['-C', source, 'status', '--porcelain'], 'Unable to inspect HCS source checkout').trim()) {
      throw new Error('HCS source checkout is dirty; commit or discard changes before fetching');
    }
    mkdirSync(join(root, '.hcs'), { recursive: true });
    partial = mkdtempSync(`${target}.partial-`);
    for (const dir of ['schemas', 'requirements', 'conformance']) cpSync(join(source, dir), join(partial, dir), { recursive: true });
    writeFileSync(join(partial, '.complete'), `${pin.commit}\n`);
    renameSync(partial, target);
    partial = undefined;
    return `Fetched HCS ${pin.commit} into ${target}`;
  } finally {
    if (partial) rmSync(partial, { recursive: true, force: true });
    if (temporary) rmSync(temporary, { recursive: true, force: true });
  }
}
