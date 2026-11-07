import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { readPin, releaseDir } from '../src/hcs/vendor.ts';

export interface HcsCase { level: string; target: string; input: unknown; expect: { outcome: string; errors?: { code: string; entry?: string }[] } }

/** Cases of the vendored HCS release (vendor/hcs/<version>/conformance/cases) with this level and target. */
export function loadCases(level: string, target: string | undefined): { name: string; value: HcsCase }[] {
  const root = resolve(import.meta.dirname, '..');
  const base = join(releaseDir(root, readPin(root)), 'conformance', 'cases');
  const cases: { name: string; value: HcsCase }[] = [];
  function visit(dir: string): void {
    for (const item of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, item.name);
      if (item.isDirectory()) visit(path);
      else if (item.isFile() && item.name.endsWith('.json')) {
        const value = JSON.parse(readFileSync(path, 'utf8')) as HcsCase;
        if (value.level === level && value.target === target) cases.push({ name: path.slice(base.length + 1), value });
      }
    }
  }
  visit(base);
  return cases;
}
