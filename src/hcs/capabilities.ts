import { HcsFailure, hcsError } from './errors.ts';
import { REWRITE_HOST, type HostProfile } from './host.ts';

export interface CapabilitySnapshot {
  readonly generation: number | null;
  readonly active: ReadonlySet<string>;
  readonly draining: ReadonlySet<string>;
}
export interface HostCapabilities { snapshot(): CapabilitySnapshot }

export function builtinCapabilities(host: HostProfile = REWRITE_HOST): HostCapabilities {
  return { snapshot: () => ({ generation: null, active: new Set(host.builtins), draining: new Set() }) };
}

export function dispatch(snapshot: CapabilitySnapshot, ref: string): void {
  const draining = snapshot.draining.has(ref);
  if (!draining && snapshot.active.has(ref)) return;
  throw new HcsFailure([hcsError('unsupported_capability', `Capability unavailable: ${ref}`, {
    capability: ref, requirement: draining ? 'HCS-0004-R006' : 'HCS-0004-R005',
  })]);
}
