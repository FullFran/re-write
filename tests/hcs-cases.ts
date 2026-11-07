import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parsePin, targetPath } from '../src/hcs/pin.ts';

export interface HcsCase { level: string; target: string; input: unknown; expect: { outcome: string; errors?: { code: string; entry?: string }[] } }
export function loadCases(level: string, target: string): { name: string; value: HcsCase }[] | undefined {
  const root = resolve(import.meta.dirname, '..');
  const pin = parsePin(readFileSync(join(root, 'hcs.pin.json'), 'utf8'));
  const base = join(targetPath(root, pin), 'conformance', 'cases');
  if (!existsSync(base)) return undefined;
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
