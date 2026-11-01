import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
export const CLI = join(ROOT, 'src/cli/main.ts');
export const FIXTURES = join(ROOT, 'fixtures/demo-book');

const owned: string[] = [];
process.on('exit', () => owned.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

export function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'rewrite-test-'));
  owned.push(dir);
  return dir;
}

// Tests own their environment: no real home, and no ambient git identity or hooks.
const ENV = {
  PATH: process.env.PATH,
  HOME: tempDir(),
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
};

export interface CliResult {
  code: number | null;
  stdout: string;
  stderr: string;
  json: any;
}

export function cli(...args: string[]): CliResult {
  const run = spawnSync(process.execPath, [CLI, ...args, '--json'], { encoding: 'utf8', env: ENV });
  let json: any = null;
  try {
    json = JSON.parse(run.stdout);
  } catch {
    // Refusals print to stderr and leave stdout empty.
  }
  return { code: run.status, stdout: run.stdout, stderr: run.stderr, json };
}

export function git(dir: string, ...args: string[]): string {
  const run = spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8', env: ENV });
  if (run.status !== 0) throw new Error(run.stderr);
  return run.stdout.trim();
}

export function read(dir: string, file: string): string {
  return readFileSync(join(dir, file), 'utf8');
}

export function newBook(): string {
  const dir = join(tempDir(), 'book');
  cli('init', dir);
  cli('import', dir, join(FIXTURES, 'escena-01.md'), join(FIXTURES, 'escena-02.md'));
  return dir;
}

export function extractedBook(): string {
  const dir = newBook();
  cli('extract', dir, '--from', join(FIXTURES, 'annotations.json'));
  return dir;
}

export function claimByQuote(dir: string, fragment: string): any {
  return cli('claims', dir).json.claims.find((c: any) => c.anchor.quote.includes(fragment));
}
