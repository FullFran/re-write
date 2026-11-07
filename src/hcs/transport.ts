import { isHcsErrorCode, type HcsError, type HcsErrorCode } from './errors.ts';
import { isDottedId, isExtensionName, parseCapabilityRef } from './ids.ts';

export const HCS_ERROR_STATUS: Readonly<Record<HcsErrorCode, number>> = {
  manifest_invalid: 422, unsupported_hcs_version: 422, duplicate_entry: 422,
  integrity_mismatch: 422, unsupported_contribution: 422, platform_incompatible: 422,
  version_incompatible: 422, missing_dependency: 409, ambiguous_provider: 409,
  dependency_cycle: 409, unsupported_capability: 404, permission_denied: 403,
  timeout: 504, plugin_failed: 502, signature_invalid: 422, rollback_rejected: 409,
};

export function validateHcsError(value: unknown): string[] {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return ['Expected an object'];
  const object = value as Record<string, unknown>;
  const violations: string[] = [];
  for (const key of Object.keys(object)) {
    if (!['code', 'message', 'entry', 'capability', 'requirement', 'details'].includes(key)) violations.push(`Unexpected member: ${key}`);
  }
  if (!isHcsErrorCode(object.code)) violations.push('Invalid code');
  if (typeof object.message !== 'string' || object.message.length === 0) violations.push('Invalid message');
  if ('entry' in object && (typeof object.entry !== 'string' || !isDottedId(object.entry))) violations.push('Invalid entry');
  if ('capability' in object && (typeof object.capability !== 'string' || !parseCapabilityRef(object.capability).ok)) violations.push('Invalid capability');
  if ('requirement' in object && (typeof object.requirement !== 'string' || !/^HCS-[0-9]{4}-R[0-9]{3}$/.test(object.requirement) || object.requirement.length !== 13)) violations.push('Invalid requirement');
  if ('details' in object) {
    if (object.details === null || typeof object.details !== 'object' || Array.isArray(object.details)) violations.push('Invalid details');
    else for (const key of Object.keys(object.details)) if (!isExtensionName(key)) violations.push(`Invalid details member: ${key}`);
  }
  return violations;
}

export function toJsonRpcError(error: HcsError, id: string | number | null) {
  return { jsonrpc: '2.0' as const, id, error: { code: -32000, message: error.message, data: { hcsError: error } } };
}

export function toProblemDetails(error: HcsError, instance?: string) {
  return { type: `urn:hcs:error:${error.code}`, title: error.code, status: HCS_ERROR_STATUS[error.code], detail: error.message, ...(instance !== undefined ? { instance } : {}), hcsError: error };
}
