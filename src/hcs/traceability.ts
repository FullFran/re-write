export interface Requirement { id: string; document: string; keyword: string }
export interface Mapping { status: 'implemented' | 'partial' | 'not-applicable' | 'planned'; issue?: number; reason?: string; code?: string[]; tests?: string[] }
export interface TraceabilityMap { documents: Record<string, Mapping>; requirements: Record<string, Mapping> }

const cell = (value: string) => value.replaceAll('|', '\\|').replace(/[\r\n]+/g, ' ');

export function generateTraceability(requirements: Requirement[], map: TraceabilityMap, commit: string): { markdown: string; errors: string[] } {
  const errors: string[] = [];
  const ids = new Set(requirements.map((r) => r.id));
  const documents = new Set(requirements.map((r) => r.document));
  for (const id of Object.keys(map.requirements)) if (!ids.has(id)) errors.push(`unknown requirement map id: ${id}`);
  for (const id of Object.keys(map.documents)) if (!documents.has(id)) errors.push(`unknown document map id: ${id}`);
  const lines = ['# HCS requirement traceability', '', `Generated from HCS pin ${commit}; do not edit.`, ''];
  for (const document of [...documents].sort()) {
    lines.push(`## ${cell(document)}`, '', '| Requirement | Keyword | Status | Where | Issue or reason |', '| --- | --- | --- | --- | --- |');
    for (const requirement of requirements.filter((r) => r.document === document).sort((a, b) => a.id.localeCompare(b.id))) {
      const entry = map.requirements[requirement.id] ?? map.documents[document];
      if (!entry || !['implemented', 'partial', 'not-applicable', 'planned'].includes(entry.status)) {
        errors.push(`${requirement.id}: missing or invalid status`);
        continue;
      }
      let where = '';
      let detail = '';
      if (entry.status === 'planned') {
        if (!Number.isSafeInteger(entry.issue) || entry.issue! <= 0) errors.push(`${requirement.id}: planned requires an issue`);
        else detail = `[#${entry.issue}](https://github.com/FullFran/re-write/issues/${entry.issue})`;
      } else if (entry.status === 'not-applicable') {
        if (typeof entry.reason !== 'string' || !entry.reason.trim()) errors.push(`${requirement.id}: not-applicable requires a reason`);
        else detail = cell(entry.reason);
      } else {
        const validPaths = (paths: unknown): paths is string[] => Array.isArray(paths) && paths.length > 0 && paths.every((p) => typeof p === 'string' && p.trim());
        if (!validPaths(entry.code) || !validPaths(entry.tests)) errors.push(`${requirement.id}: ${entry.status} requires code and tests paths`);
        else where = [...entry.code, ...entry.tests].map((p) => `\`${cell(p)}\``).join(', ');
      }
      lines.push(`| ${cell(requirement.id)} | ${cell(requirement.keyword)} | ${entry.status} | ${where} | ${detail} |`);
    }
    lines.push('');
  }
  return { markdown: lines.join('\n'), errors };
}
