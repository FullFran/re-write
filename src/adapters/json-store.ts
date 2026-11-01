import { mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export const STATE_DIR = '.rewrite';

/** Ids come from outside, so they can never name a path. */
const SAFE_ID = /^[\w-]+$/;

/** One JSON file per record, inside the book repository, so git versions the state. */
export class JsonStore<T> {
  private readonly dir: string;

  constructor(root: string, collection: string) {
    this.dir = join(root, STATE_DIR, collection);
  }

  get(id: string): T | null {
    if (!SAFE_ID.test(id)) return null;
    try {
      return JSON.parse(readFileSync(join(this.dir, `${id}.json`), 'utf8')) as T;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }

  put(id: string, value: T): void {
    if (!SAFE_ID.test(id)) throw new Error(`invalid record id: ${id}`);
    const path = join(this.dir, `${id}.json`);
    mkdirSync(dirname(path), { recursive: true });
    const temporary = `${path}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`);
    renameSync(temporary, path);
  }

  all(): T[] {
    let names: string[];
    try {
      names = readdirSync(this.dir);
    } catch {
      return [];
    }
    return names
      .filter((name) => name.endsWith('.json'))
      .sort()
      .map((name) => JSON.parse(readFileSync(join(this.dir, name), 'utf8')) as T);
  }
}
