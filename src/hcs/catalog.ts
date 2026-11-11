import { hcsError, type HcsError } from './errors.ts';
import { isDottedId, isExtensionName, parseCapabilityRef } from './ids.ts';
import { partitionMembers } from './extensions.ts';
import { HCS_VERSION } from './version.ts';

export interface Contribution { kind: string; path: string; provides?: string[]; [key: string]: unknown }
export interface CatalogEntry { id: string; version: string; contentHash: string; contentId?: string; size: number; mediaType: string; contributions: Contribution[]; locations?: string[]; requires?: string[]; compatibility?: { platforms?: Record<string, unknown>[]; hosts?: Record<string, unknown>[]; [key: string]: unknown }; [key: string]: unknown }
export interface CatalogManifest { hcsVersion: string; id: string; version: string; entries: CatalogEntry[]; [key: string]: unknown }
export const DEFAULT_LIMITS = { maxBytes: 4_194_304, maxDepth: 64 };

type Obj = Record<string, unknown>;
const object = (v: unknown): v is Obj => v !== null && typeof v === 'object' && !Array.isArray(v);
const text = (v: unknown): v is string => typeof v === 'string';
const version = (v: unknown) => text(v) && v.length > 0 && [...v].length <= 128 && !/\s/u.test(v);
const dotted = (v: unknown) => text(v) && v.length <= 128 && isDottedId(v);
const exact = (re: RegExp, v: unknown) => text(v) && re.test(v) && !v.endsWith('\n');

export function readCatalog(bytes: Uint8Array | string, limits = DEFAULT_LIMITS): { ok: true; catalog: CatalogManifest } | { ok: false; errors: HcsError[] } {
  const fail = (message: string, pointer = '', requirement = 'HCS-0001-R001') => ({ ok: false as const, errors: [hcsError('manifest_invalid', message, { requirement, details: { 'x-rewrite-pointer': pointer } })] });
  if ((typeof bytes === 'string' ? Buffer.byteLength(bytes) : bytes.byteLength) > limits.maxBytes) return fail('Catalog exceeds size limit', '', 'HCS-0001-R015');
  const source = typeof bytes === 'string' ? bytes : new TextDecoder().decode(bytes);
  let depth = 0, quoted = false, escaped = false;
  for (const ch of source) {
    if (quoted) { if (escaped) escaped = false; else if (ch === '\\') escaped = true; else if (ch === '"') quoted = false; }
    else if (ch === '"') quoted = true;
    else if (ch === '{' || ch === '[') { if (++depth > limits.maxDepth) return fail('Catalog exceeds depth limit', '', 'HCS-0001-R015'); }
    else if (ch === '}' || ch === ']') depth--;
  }
  let doc: unknown;
  try { doc = JSON.parse(source); } catch { return fail('Catalog is not valid JSON'); }
  if (!object(doc)) return fail('Catalog must be an object');
  if (doc.hcsVersion !== HCS_VERSION) return { ok: false, errors: [hcsError('unsupported_hcs_version', 'Unsupported HCS version', { requirement: 'HCS-0001-R002', details: { 'x-rewrite-pointer': '/hcsVersion' } })] };
  const errors: HcsError[] = [];
  const invalid = (p: string, requirement = 'HCS-0001-R001') => { errors.push(hcsError('manifest_invalid', 'Invalid catalog member', { requirement, details: { 'x-rewrite-pointer': p } })); };
  const ptr = (p: string, k: string | number) => `${p}/${String(k).replace(/~/g, '~0').replace(/\//g, '~1')}`;
  const members = (v: unknown, p: string, allowed: string[], required: string[]): v is Obj => {
    if (!object(v)) { invalid(p); return false; }
    const { core, invalidExtensionNames } = partitionMembers(v);
    for (const k of [...Object.keys(core).filter(k => !allowed.includes(k)), ...invalidExtensionNames]) invalid(ptr(p, k));
    for (const k of required) if (!(k in v)) invalid(ptr(p, k));
    return true;
  };
  const field = (o: Obj, k: string, p: string, check: (v: unknown) => boolean, req?: string) => { if (k in o && !check(o[k])) invalid(ptr(p, k), req); };
  const list = (v: unknown, p: string, item: (v: unknown, p: string) => void, min = 0, unique = false) => {
    if (!Array.isArray(v)) { invalid(p); return; }
    if (v.length < min) invalid(p);
    if (unique && new Set(v).size !== v.length) invalid(p);
    v.forEach((x, i) => item(x, ptr(p, i)));
  };
  const refs = (v: unknown, p: string) => list(v, p, (x, q) => { if (!text(x) || x.length > 140 || !parseCapabilityRef(x).ok) invalid(q); }, 0, true);
  const contribution = (v: unknown, p: string) => {
    if (!members(v, p, ['kind', 'path', 'provides'], ['kind', 'path'])) return;
    field(v, 'kind', p, x => text(x) && (x === 'skill' || x === 'mcp-server' || isExtensionName(x)), 'HCS-0001-R006');
    field(v, 'path', p, x => text(x) && [...x].length > 0 && [...x].length <= 1024 && !x.startsWith('/') && !x.includes('\\') && !x.includes('\0') && !x.split('/').includes('..'), 'HCS-0001-R005');
    if ('provides' in v) refs(v.provides, ptr(p, 'provides'));
  };
  const platform = (v: unknown, p: string) => { if (!members(v, p, ['os', 'architecture', 'variant'], ['os', 'architecture'])) return; for (const k of ['os', 'architecture', 'variant']) field(v, k, p, x => text(x) && x.length > 0); };
  const host = (v: unknown, p: string) => { if (!members(v, p, ['id', 'versions'], ['id', 'versions'])) return; field(v, 'id', p, dotted); if ('versions' in v) list(v.versions, ptr(p, 'versions'), (x, q) => { if (!version(x)) invalid(q); }, 1, true); };
  const entry = (v: unknown, p: string) => {
    if (!members(v, p, ['id', 'version', 'contentHash', 'contentId', 'size', 'mediaType', 'locations', 'contributions', 'requires', 'compatibility'], ['id', 'version', 'contentHash', 'size', 'mediaType', 'contributions'])) return;
    field(v, 'id', p, dotted); field(v, 'version', p, version);
    field(v, 'contentHash', p, x => exact(/^(?:sha256:[a-f0-9]{64}|sha512:[a-f0-9]{128})$/, x), 'HCS-0001-R004');
    field(v, 'contentId', p, x => exact(/^(?:sha256:[a-f0-9]{64}|sha512:[a-f0-9]{128})$/, x), 'HCS-0001-R017');
    field(v, 'size', p, x => typeof x === 'number' && Number.isInteger(x) && x >= 0);
    field(v, 'mediaType', p, x => exact(/^[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]{0,126}\/[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]{0,126}$/, x), 'HCS-0001-R011');
    if ('locations' in v) list(v.locations, ptr(p, 'locations'), (x, q) => { if (!exact(/^[A-Za-z][A-Za-z0-9+.-]*:[^\s]+$/, x)) invalid(q); }, 0, true);
    if ('contributions' in v) list(v.contributions, ptr(p, 'contributions'), contribution, 1);
    if ('requires' in v) refs(v.requires, ptr(p, 'requires'));
    if ('compatibility' in v) { const q = ptr(p, 'compatibility'), c = v.compatibility; if (members(c, q, ['platforms', 'hosts'], [])) { if ('platforms' in c) list(c.platforms, ptr(q, 'platforms'), platform, 1); if ('hosts' in c) list(c.hosts, ptr(q, 'hosts'), host, 1); } }
  };
  members(doc, '', ['hcsVersion', 'id', 'version', 'entries'], ['hcsVersion', 'id', 'version', 'entries']);
  field(doc, 'id', '', dotted); field(doc, 'version', '', version);
  if ('entries' in doc) list(doc.entries, '/entries', entry);
  if (errors.length) return { ok: false, errors };
  const seen = new Set<string>();
  for (const e of doc.entries as CatalogEntry[]) { if (seen.has(e.id)) errors.push(hcsError('duplicate_entry', 'Duplicate catalog entry', { entry: e.id, requirement: 'HCS-0001-R003' })); else seen.add(e.id); }
  return errors.length ? { ok: false, errors } : { ok: true, catalog: doc as unknown as CatalogManifest };
}
