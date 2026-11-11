import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { test as base } from '@playwright/test';

const ROOT = resolve(import.meta.dirname, '..');
const CLI = join(ROOT, 'src/cli/main.ts');
export const ANNOTATIONS = join(ROOT, 'fixtures/demo-book/annotations.json');

export interface Book {
  /** Origin of the real server; the page is at /review. */
  base: string;
  book: string;
  dir: string;
  /** Runs the rewrite CLI against this book's directory and returns its JSON. */
  cli: (command: string, ...args: string[]) => any;
  /** The manuscript bytes on disk. */
  bytes: (file: string) => Buffer;
  git: (...args: string[]) => string;
}

function start(): Promise<{ child: ChildProcess; info: { base: string; book: string; bookDir: string } }> {
  const child = spawn(process.execPath, [join(import.meta.dirname, 'server.ts')], { stdio: ['pipe', 'pipe', 'inherit'] });
  return new Promise((resolve, reject) => {
    child.once('exit', (code) => reject(new Error(`test server exited with ${code}`)));
    createInterface({ input: child.stdout! }).on('line', (line) => {
      if (line.startsWith('{"base"')) resolve({ child, info: JSON.parse(line) });
    });
  });
}

export const test = base.extend<{ book: Book }>({
  // Nothing leaves loopback: the page's Clerk scripts come from the fake issuer.
  context: async ({ context }, use) => {
    await context.route((url) => url.hostname !== '127.0.0.1', (route) => route.abort());
    await use(context);
  },
  book: async ({}, use) => {
    const { child, info } = await start();
    const home = mkdtempSync(join(tmpdir(), 'rewrite-browser-home-'));
    const env = { PATH: process.env.PATH, HOME: home, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
    const run = (program: string, args: string[]) => {
      const done = spawnSync(program, args, { encoding: 'utf8', env });
      if (done.status !== 0) throw new Error(`${program} ${args.join(' ')}: ${done.stderr}`);
      return done.stdout;
    };
    await use({
      base: info.base,
      book: info.book,
      dir: info.bookDir,
      cli: (command, ...args) => JSON.parse(run(process.execPath, [CLI, command, info.bookDir, ...args, '--json'])),
      bytes: (file) => readFileSync(join(info.bookDir, file)),
      git: (...args) => run('git', ['-C', info.bookDir, ...args]).trim(),
    });
    child.removeAllListeners('exit');
    const exited = new Promise((resolve) => child.once('exit', resolve));
    child.stdin!.end();
    await exited;
    rmSync(home, { recursive: true, force: true });
  },
});

export { expect } from '@playwright/test';
