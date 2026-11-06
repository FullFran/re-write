import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parsePin, targetPath } from '../src/hcs/pin.ts';
import { generateTraceability, type Requirement, type TraceabilityMap } from '../src/hcs/traceability.ts';

function run(): void {
  const root = resolve(import.meta.dirname, '..');
  const pin = parsePin(readFileSync(join(root, 'hcs.pin.json'), 'utf8'));
  const target = targetPath(root, pin);
  const input = join(target, 'requirements', 'requirements.json');
  if (!existsSync(join(target, '.complete')) || !existsSync(input)) throw new Error('HCS requirements not fetched; run npm run hcs:fetch');
  const data = JSON.parse(readFileSync(input, 'utf8'));
  if (!Array.isArray(data.requirements)) throw new Error('Invalid HCS requirements list');
  const requirements: Requirement[] = data.requirements.map((r: Requirement) => ({ id: r.id, document: r.document, keyword: r.keyword }));
  if (requirements.some((r) => typeof r.id !== 'string' || typeof r.document !== 'string' || typeof r.keyword !== 'string')) throw new Error('Invalid HCS requirement metadata');
  const map = JSON.parse(readFileSync(join(root, 'docs/conformance/traceability.map.json'), 'utf8')) as TraceabilityMap;
  const result = generateTraceability(requirements, map, pin.commit);
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
