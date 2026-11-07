import { isDottedId, isExtensionName, parseCapabilityRef } from './ids.ts';

// Closed set of HCS error codes (HCS-0006-R002). Product refusals are not HCS errors.
export const HCS_ERROR_CODES = [
  'manifest_invalid',
  'unsupported_hcs_version',
  'duplicate_entry',
  'integrity_mismatch',
  'unsupported_contribution',
  'platform_incompatible',
  'missing_dependency',
  'version_incompatible',
  'ambiguous_provider',
  'dependency_cycle',
  'permission_denied',
  'unsupported_capability',
  'timeout',
  'plugin_failed',
  'signature_invalid',
  'rollback_rejected',
] as const;

export type HcsErrorCode = (typeof HCS_ERROR_CODES)[number];

// HCS-0006 error object. `details` members must be extension names (`x-...`).
export interface HcsError {
  code: HcsErrorCode;
  message: string;
  entry?: string;
  capability?: string;
  requirement?: string;
  details?: Record<string, unknown>;
}

export function isHcsErrorCode(value: unknown): value is HcsErrorCode {
  return typeof value === 'string' && (HCS_ERROR_CODES as readonly string[]).includes(value);
}

const requirementPattern = /^HCS-[0-9]{4}-R[0-9]{3}$/;

export function hcsError(
  code: HcsErrorCode,
  message: string,
  extra: Omit<HcsError, 'code' | 'message'> = {},
): HcsError {
  if (!isHcsErrorCode(code)) throw new TypeError(`Not an HCS error code: ${String(code)}`);
  if (message.length === 0) throw new TypeError('HCS error message must not be empty');
  if (extra.entry !== undefined && !isDottedId(extra.entry)) throw new TypeError(`Not an HCS entry id: ${extra.entry}`);
  if (extra.capability !== undefined && !parseCapabilityRef(extra.capability).ok) throw new TypeError(`Not an HCS capability ref: ${extra.capability}`);
  if (extra.requirement !== undefined && (!requirementPattern.test(extra.requirement) || extra.requirement.length !== 13)) {
    throw new TypeError(`Not an HCS requirement id: ${extra.requirement}`);
  }
  for (const key of Object.keys(extra.details ?? {})) {
    if (!isExtensionName(key)) throw new TypeError(`HCS error details member must be an extension name: ${key}`);
  }
  const error: HcsError = { code, message };
  if (extra.entry !== undefined) error.entry = extra.entry;
  if (extra.capability !== undefined) error.capability = extra.capability;
  if (extra.requirement !== undefined) error.requirement = extra.requirement;
  if (extra.details !== undefined) error.details = { ...extra.details };
  return error;
}

// Thrown by host operations that fail with one or more HCS errors.
export class HcsFailure extends Error {
  readonly errors: readonly HcsError[];
  constructor(errors: readonly HcsError[]) {
    if (errors.length === 0) throw new TypeError('HcsFailure requires at least one error');
    super(errors.map(e => `${e.code}: ${e.message}`).join('; '));
    this.name = 'HcsFailure';
    this.errors = errors;
  }
}
