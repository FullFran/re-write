import type { CatalogManifest } from './catalog.ts';
import { hcsError, type HcsError, type HcsErrorCode } from './errors.ts';
import { capabilitySatisfies, parseCapabilityRef } from './ids.ts';
import type { HostProfile } from './host.ts';

const byteOrder = (a: string, b: string) => Buffer.compare(Buffer.from(a), Buffer.from(b));

export function resolve(catalog: CatalogManifest, host: HostProfile): { activationOrder: string[]; errors: HcsError[]; selected: string[] } {
  const errors: HcsError[] = [];
  const failed = new Set<string>();
  const report = (code: HcsErrorCode, entry: string, requirement: string, capability?: string) => {
    errors.push(hcsError(code, code.replaceAll('_', ' '), { entry, requirement, ...(capability === undefined ? {} : { capability }) }));
    failed.add(entry);
  };
  for (const e of catalog.entries) {
    const compat = e.compatibility;
    if (!host.mediaTypes.includes(e.mediaType)) report('unsupported_contribution', e.id, 'HCS-0001-R013');
    else if (e.contributions.some(c => !host.contributionKinds.includes(c.kind))) report('unsupported_contribution', e.id, 'HCS-0001-R008');
    else if (compat?.platforms && !compat.platforms.some(p => p.os === host.platform.os && p.architecture === host.platform.architecture && (p.variant === undefined || p.variant === host.platform.variant))) report('platform_incompatible', e.id, 'HCS-0001-R009');
    else if (compat?.hosts && !compat.hosts.some(h => h.id === host.id && Array.isArray(h.versions) && h.versions.includes(host.version))) report('version_incompatible', e.id, 'HCS-0001-R016');
  }
  const eligible = catalog.entries.filter(e => !failed.has(e.id));
  const provided = new Map(catalog.entries.map(e => [e.id, new Set(e.contributions.flatMap(c => c.provides ?? []))]));
  let edges = new Map<string, Set<string>>();
  while (true) {
    const live = catalog.entries.filter(e => !failed.has(e.id));
    edges = new Map();
    let changed = false;
    for (const e of live) {
      const dependencies = new Set<string>(); edges.set(e.id, dependencies);
      for (const ref of e.requires ?? []) {
        const candidates = live.filter(p => p.id !== e.id && [...provided.get(p.id)!].some(r => capabilitySatisfies(ref, r)));
        const count = candidates.length + Number(host.builtins.some(r => capabilitySatisfies(ref, r)));
        if (count === 1) { for (const c of candidates) dependencies.add(c.id); continue; }
        const need = parseCapabilityRef(ref);
        const alternatives = [...host.builtins, ...live.filter(p => p.id !== e.id).flatMap(p => [...provided.get(p.id)!])];
        const otherMajor = need.ok && alternatives.some(r => { const have = parseCapabilityRef(r); return have.ok && have.id === need.id; });
        const code = count > 1 ? 'ambiguous_provider' : otherMajor ? 'version_incompatible' : 'missing_dependency';
        const failedProvider = code === 'missing_dependency' && eligible.some(p => p.id !== e.id && failed.has(p.id) && [...provided.get(p.id)!].some(r => capabilitySatisfies(ref, r)));
        report(code, e.id, code === 'ambiguous_provider' ? 'HCS-0003-R004' : code === 'version_incompatible' ? 'HCS-0003-R003' : failedProvider ? 'HCS-0003-R005' : 'HCS-0003-R002', ref);
        changed = true; break;
      }
    }
    if (changed) continue;
    const cyclic = new Set<string>();
    for (const id of edges.keys()) {
      const seen = new Set<string>();
      const reaches = (current: string): boolean => {
        for (const next of edges.get(current) ?? []) {
          if (next === id) return true;
          if (!seen.has(next)) { seen.add(next); if (reaches(next)) return true; }
        }
        return false;
      };
      if (reaches(id)) cyclic.add(id);
    }
    if (!cyclic.size) break;
    for (const id of [...cyclic].sort(byteOrder)) report('dependency_cycle', id, 'HCS-0003-R006');
  }
  const activationOrder: string[] = [];
  const remaining = new Set(edges.keys());
  while (remaining.size) {
    const next = [...remaining].filter(id => [...edges.get(id)!].every(dep => !remaining.has(dep))).sort(byteOrder)[0];
    activationOrder.push(next); remaining.delete(next);
  }
  return { activationOrder, errors, selected: host.activationPolicy === 'all-or-nothing' && errors.length ? [] : [...activationOrder] };
}
