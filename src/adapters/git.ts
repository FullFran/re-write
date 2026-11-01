import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Thin wrapper over git. Arguments are always passed as an array, never through a shell. */
export class Git {
  private readonly dir: string;

  constructor(dir: string) {
    this.dir = dir;
  }

  run(...args: string[]): string {
    return execFileSync('git', ['-C', this.dir, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  }

  /** Runs git and returns null on failure, for lookups that may legitimately miss. */
  tryRun(...args: string[]): string | null {
    const result = spawnSync('git', ['-C', this.dir, ...args], { encoding: 'utf8' });
    return result.status === 0 ? result.stdout : null;
  }

  init(): void {
    this.run('init', '-q', '-b', 'main');
    // A clean machine may have no git identity, and committing must still work.
    if (this.tryRun('config', 'user.email') === null) {
      this.run('config', 'user.email', 'rewrite@localhost');
      this.run('config', 'user.name', 'RE;write local');
    }
  }

  head(): string {
    return this.run('rev-parse', 'HEAD').trim();
  }

  /** Reads a file as it was at a revision, or null when the revision or path does not exist. */
  showAt(revision: string, file: string): string | null {
    if (!/^[0-9a-f]{40}$/.test(revision)) return null;
    return this.tryRun('show', `${revision}:${file}`);
  }

  blobOf(file: string): string {
    return this.run('hash-object', '--', file).trim();
  }

  isDirty(file: string): boolean {
    return this.run('status', '--porcelain', '--', file).trim() !== '';
  }

  /** Unified diff of two texts, labelled with the given names and free of temporary paths. */
  diffTexts(before: string, after: string, beforeLabel: string, afterLabel: string): string {
    const scratch = mkdtempSync(join(tmpdir(), 'rewrite-diff-'));
    try {
      writeFileSync(join(scratch, 'before'), before);
      writeFileSync(join(scratch, 'after'), after);
      // git diff --no-index exits 1 when the texts differ, which is the expected case.
      // --text keeps a real diff even for text git would call binary, so a reviewer always sees the change.
      const { stdout } = spawnSync('git', ['diff', '--no-index', '--no-color', '--text', '--', 'before', 'after'], { cwd: scratch, encoding: 'utf8' });
      const hunks = stdout.slice(stdout.indexOf('@@'));
      return `--- ${beforeLabel}\n+++ ${afterLabel}\n${hunks}`;
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  }

  /** Commits only these paths, so unrelated edits by the author stay out of the commit. */
  commit(message: string, paths: string[]): void {
    this.run('add', '--', ...paths);
    this.run('commit', '-q', '--no-verify', '-m', message, '--', ...paths);
  }

  /** Finds the commit whose subject is exactly this message. */
  commitWithSubject(subject: string): string | null {
    const hit = this.tryRun('log', '-1', '--format=%H', '--fixed-strings', `--grep=${subject}`);
    return hit?.trim() || null;
  }
}
