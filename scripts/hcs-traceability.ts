import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { readPin, releaseDir } from '../src/hcs/vendor.ts';
import { generateTraceability, type Requirement } from '../src/hcs/traceability.ts';

function run(): void {
  const root = resolve(import.meta.dirname, '..');
  const pin = readPin(root);
  const input = join(releaseDir(root, pin), 'requirements', 'requirements.json');
  if (!existsSync(input)) throw new Error(`HCS requirements are not vendored: vendor/hcs/${pin.version}/requirements/requirements.json; run npm run hcs:sync`);
  const data = JSON.parse(readFileSync(input, 'utf8'));
  if (!data || typeof data !== 'object' || !Array.isArray(data.requirements)) throw new Error('Invalid HCS requirements list');
  const requirements: Requirement[] = data.requirements.map((r: Requirement | null) => ({ id: r?.id, document: r?.document, keyword: r?.keyword }));
  if (requirements.some((r) => typeof r.id !== 'string' || typeof r.document !== 'string' || typeof r.keyword !== 'string')) throw new Error('Invalid HCS requirement metadata');
  const map: unknown = JSON.parse(readFileSync(join(root, 'docs/conformance/traceability.map.json'), 'utf8'));
  const result = generateTraceability(requirements, map, pin.version);
  if (result.errors.length) throw new Error(`Traceability validation failed:\n${result.errors.join('\n')}`);
  const output = join(root, 'docs/conformance/traceability.md');
  if (process.argv.includes('--check')) {
    const existing = existsSync(output) ? readFileSync(output, 'utf8') : '';
    if (existing !== result.markdown) {
      const before = existing.split('\n');
      const after = result.markdown.split('\n');
      let line = 0;
      while (line < before.length && line < after.length && before[line] === after[line]) line++;
      throw new Error(`Traceability drift: first difference at line ${line + 1} (existing ${before.length} lines, generated ${after.length} lines); run npm run hcs:trace`);
    }
    console.log('Traceability is up to date');
  } else {
    writeFileSync(output, result.markdown);
    console.log('Generated docs/conformance/traceability.md');
  }
}

try { run(); } catch (error) {
  console.error(`HCS traceability failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
