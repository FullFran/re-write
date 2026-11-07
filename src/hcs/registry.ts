import { dispatch, type CapabilitySnapshot, type HostCapabilities } from './capabilities.ts';
import { REWRITE_HOST, type HostProfile } from './host.ts';
import { readHostState } from './host-state.ts';
import type { EntryState } from './lifecycle.ts';

export interface RegistryEntry { entry: string; state: EntryState; provides: string[] }
export interface RegistryInput { generation: number | null; entries: RegistryEntry[] }

// Capabilities of one generation. Only `active` entries take calls (HCS-0004-R005); a `draining`
// entry takes no new calls (HCS-0004-R006). In-flight calls are not tracked here.
export class CapabilityRegistry {
  readonly generation: number | null;
  readonly entries: readonly RegistryEntry[];
  readonly host: HostProfile;
  constructor(input: RegistryInput, host: HostProfile = REWRITE_HOST) {
    this.generation = input.generation;
    this.entries = input.entries.map(e => ({ ...e, provides: [...e.provides] }));
    this.host = host;
  }
  snapshot(): CapabilitySnapshot {
    const active = new Set(this.host.builtins), draining = new Set<string>();
    for (const e of this.entries) for (const ref of e.provides) {
      if (e.state === 'active') active.add(ref);
      else if (e.state === 'draining') draining.add(ref);
    }
    return { generation: this.generation, active, draining };
  }
  // Returns the providing entry id, or the host id for a host built-in.
  dispatch(ref: string): string {
    dispatch(this.snapshot(), ref);
    const provider = this.entries.find(e => e.state === 'active' && e.provides.includes(ref));
    return provider ? provider.entry : this.host.id ?? 'host';
  }
}

export function loadRegistry(stateDir: string, host: HostProfile = REWRITE_HOST): CapabilityRegistry {
  const state = readHostState(stateDir);
  const provides = new Map((state.record?.entries ?? []).map(e => [e.id, e.contributions.flatMap(c => c.provides ?? [])]));
  return new CapabilityRegistry({
    generation: state.generation,
    entries: state.entries.map(s => ({ entry: s.entry, state: s.state, provides: provides.get(s.entry) ?? [] })),
  }, host);
}

// Host built-ins plus the capabilities of the active generation, read on every snapshot.
export function generationCapabilities(stateDir: string, host: HostProfile = REWRITE_HOST): HostCapabilities {
  return { snapshot: () => loadRegistry(stateDir, host).snapshot() };
}
