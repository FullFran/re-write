import { hcsError, type HcsError } from './errors.ts';
import { isDottedId, isExtensionName } from './ids.ts';
import { HCS_VERSION } from './version.ts';

// HCS-0005 objects. A request asks for authority; only a grant held by the host gives it.
export interface PermissionRequest { permission: string; reason?: string; [member: `x-${string}`]: unknown }
export interface Grant { entry: string; permission: string; session?: string }
export type Denial = Grant;
export interface Check { entry: string; permission: string; session?: string }
export type Decision = { allow: true } | { allow: false; error: HcsError };

// A grant or denial with a `session` matches only checks from that session; one without a session
// matches every check (HCS-0005-R008).
const matches = (check: Check) => (held: Grant) => held.entry === check.entry && held.permission === check.permission
  && (held.session === undefined || held.session === check.session);

// Allows only with a grant for exactly this entry and permission (HCS-0005-R001), and only when no
// stored denial matches too (R007). It takes grants and denials alone: requests, Agent Skills
// `allowed-tools` and `x-` members cannot reach it (R002, R004).
export function evaluate(check: Check, grants: readonly Grant[], denials: readonly Denial[] = []): Decision {
  const denied = denials.some(matches(check));
  if (!denied && grants.some(matches(check))) return { allow: true };
  return { allow: false, error: hcsError('permission_denied', `Permission denied: ${check.permission}`, {
    entry: check.entry, requirement: denied ? 'HCS-0005-R007' : 'HCS-0005-R001',
  }) };
}

type Obj = Record<string, unknown>;
const object = (value: unknown): value is Obj => value !== null && typeof value === 'object' && !Array.isArray(value);
const onlyMembers = (value: Obj, allowed: string[]) => Object.keys(value).every(key => allowed.includes(key) || isExtensionName(key));

// Reads an HCS-0005 request document for `entry` and returns the permissions it requests.
// Throws on a document that is malformed or written for another entry.
export function readRequestDocument(value: unknown, entry: string): PermissionRequest[] {
  if (!object(value) || !onlyMembers(value, ['hcsVersion', 'entry', 'requests'])) throw new Error('Invalid request document');
  if (value.hcsVersion !== HCS_VERSION) throw new Error('Unsupported request document version');
  if (value.entry !== entry) throw new Error('Request document names another entry');
  if (!Array.isArray(value.requests)) throw new Error('Invalid request document');
  return value.requests.map((request: unknown) => {
    if (!object(request) || !onlyMembers(request, ['permission', 'reason'])
      || typeof request.permission !== 'string' || request.permission.length > 128 || !isDottedId(request.permission)
      || (request.reason !== undefined && (typeof request.reason !== 'string' || request.reason.length > 1024))) {
      throw new Error('Invalid permission request');
    }
    return request as PermissionRequest;
  });
}
