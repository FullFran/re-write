// Vendors one pinned HCS release (https://github.com/FullFran/hcs) into vendor/hcs/<version>/, following the
// upstream "How to pin HCS" recipe: download the release tarball, refuse it unless its sha256 is the pinned
// digest, unpack it, check every file against the release's own SHA256SUMS and record the pin in
// vendor/hcs/PIN.json. Nothing from the release is executed. Guide: docs/hcs.md.
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { readTar } from './tar.ts';
import { HCS_VERSION } from './version.ts';

export const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z]+(?:\.[0-9A-Za-z]+)*)?$/;
export const SHA256 = /^[a-f0-9]{64}$/;
export const PIN_FILE = 'PIN.json';
export const SUMS_FILE = 'SHA256SUMS';
/** Upper bound for the downloaded tarball and for its unpacked size. */
export const MAX_TARBALL_BYTES = 64 * 1024 * 1024;

export interface HcsPin { version: string; sha256: string; url: string }

export class UsageError extends Error {}

const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

export const releaseUrl = (version: string) => `https://github.com/FullFran/hcs/releases/download/v${version}/hcs-${version}.tar.gz`;
export const vendorDir = (root: string) => join(root, 'vendor', 'hcs');
export const releaseDir = (root: string, pin: HcsPin) => join(vendorDir(root), pin.version);

/** The contract version (`MAJOR.MINOR`) a release version belongs to: `0.1.0-draft.2` is `0.1`. */
export function contractVersion(version: string): string {
  return version.split('.').slice(0, 2).join('.');
}

export function parsePin(contents: string): HcsPin {
  let pin: unknown;
  try { pin = JSON.parse(contents); } catch { throw new Error('HCS pin is malformed JSON'); }
  if (!pin || typeof pin !== 'object' || Array.isArray(pin)) throw new Error('HCS pin must be an object');
  const { version, sha256: digest, url } = pin as Record<string, unknown>;
  if (typeof version !== 'string' || !VERSION.test(version)) throw new Error('HCS pin version must be a release version');
  if (contractVersion(version) !== HCS_VERSION) throw new Error(`HCS pin version must belong to contract ${HCS_VERSION}`);
  if (typeof digest !== 'string' || !SHA256.test(digest)) throw new Error('HCS pin sha256 must be 64 lowercase hexadecimal characters');
  if (url !== releaseUrl(version)) throw new Error(`HCS pin url must be ${releaseUrl(version)}`);
  return { version, sha256: digest, url };
}

/** vendor/hcs/PIN.json of `root`. */
export function readPin(root: string): HcsPin {
  let contents: string;
  try { contents = readFileSync(join(vendorDir(root), PIN_FILE), 'utf8'); }
  catch { throw new Error(`HCS pin is missing or unreadable: vendor/hcs/${PIN_FILE}`); }
  return parsePin(contents);
}

/** `{ "rel/path": "<hex>" }` from `sha256sum` output (`<hex>  <path>`, or `<hex> *<path>` for binary mode). */
export function parseSums(text: string): Map<string, string> {
  const sums = new Map<string, string>();
  for (const line of text.split('\n')) {
    if (line === '') continue;
    const match = /^([a-f0-9]{64}) [ *](.+)$/.exec(line);
    if (!match) throw new Error(`${SUMS_FILE}: unreadable line '${line}'`);
    if (sums.has(match[2])) throw new Error(`${SUMS_FILE}: '${match[2]}' is listed twice`);
    sums.set(match[2], match[1]);
  }
  return sums;
}

/**
 * Checks `files` against their SHA256SUMS: every listed file present with its digest, and no file the list does
 * not name. Throws an Error naming every offending path; returns the number of listed files.
 */
export function verifyFiles(files: Map<string, Uint8Array>): number {
  const list = files.get(SUMS_FILE);
  if (!list) throw new Error(`the release has no ${SUMS_FILE}`);
  const sums = parseSums(Buffer.from(list).toString('utf8'));
  const problems: string[] = [];
  for (const [name, hex] of sums) {
    const bytes = files.get(name);
    if (!bytes) problems.push(`${name}: missing`);
    else if (sha256(bytes) !== hex) problems.push(`${name}: sha256 differs from ${SUMS_FILE}`);
  }
  for (const name of files.keys()) if (name !== SUMS_FILE && !sums.has(name)) problems.push(`${name}: not listed in ${SUMS_FILE}`);
  if (problems.length) throw new Error(`HCS release integrity check failed:\n  ${problems.sort().join('\n  ')}`);
  return sums.size;
}

function listFiles(dir: string, base = dir): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listFiles(full, base));
    else out.push(relative(base, full).split(sep).join('/'));
  }
  return out;
}

/** verifyFiles over a vendored folder on disk. */
export function verifyTree(dir: string): number {
  const files = new Map<string, Uint8Array>();
  for (const name of listFiles(dir)) files.set(name, readFileSync(join(dir, ...name.split('/'))));
  return verifyFiles(files);
}

function paxPath(data: Buffer): string | undefined {
  let path: string | undefined;
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    const length = space < 0 ? NaN : Number(data.subarray(offset, space).toString('ascii'));
    if (!Number.isSafeInteger(length) || length <= 0 || offset + length > data.length) throw new Error('the tarball holds a malformed pax header');
    const record = data.subarray(space + 1, offset + length - 1).toString('utf8');
    const equals = record.indexOf('=');
    if (equals > 0 && record.slice(0, equals) === 'path') path = record.slice(equals + 1);
    offset += length;
  }
  return path;
}

/**
 * Unpacks a release tarball in memory: regular files and folders only, every name under `hcs-<version>/`, no
 * absolute path, `..`, link or special file. Returns the files keyed by their path inside the release.
 */
export function unpackRelease(tarball: Uint8Array, version: string): Map<string, Uint8Array> {
  const tar = gunzipSync(tarball, { maxOutputLength: MAX_TARBALL_BYTES });
  const top = `hcs-${version}/`;
  const files = new Map<string, Uint8Array>();
  let next: string | undefined;
  for (const member of readTar(tar)) {
    if (member.type === 'x') { next = paxPath(member.data); continue; }
    const name = next ?? member.name;
    next = undefined;
    if (member.type !== '0' && member.type !== '5') throw new Error(`the tarball holds '${name}', which is not a regular file or folder`);
    const parts = name.replace(/\/$/, '').split('/');
    if (name.startsWith('/') || name.includes('\\') || parts.some(part => part === '' || part === '.' || part === '..')) throw new Error(`the tarball holds an unsafe path '${name}'`);
    if (!`${name}/`.startsWith(top)) throw new Error(`the tarball holds '${name}' outside ${top}`);
    if (member.type === '0') {
      const path = name.slice(top.length);
      if (!path) throw new Error(`the tarball holds a file named like its top folder '${name}'`);
      if (files.has(path)) throw new Error(`the tarball holds '${name}' twice`);
      files.set(path, member.data);
    }
  }
  return files;
}

async function download(url: string): Promise<Buffer> {
  const response = await fetch(url, { redirect: 'follow' });
  if (!response.ok) throw new Error(`GET ${url}: HTTP ${response.status}`);
  const declared = Number(response.headers.get('content-length'));
  if (declared > MAX_TARBALL_BYTES) throw new Error(`GET ${url}: ${declared} bytes, over ${MAX_TARBALL_BYTES}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > MAX_TARBALL_BYTES) throw new Error(`GET ${url}: ${bytes.length} bytes, over ${MAX_TARBALL_BYTES}`);
  return bytes;
}

/**
 * Downloads, checks and vendors `version`. The tree is written to a sibling temporary folder and renamed into
 * place only after every check passed, so a refused release leaves the previous tree and pin untouched.
 * `url` defaults to the release asset; only tests point it elsewhere, and the pin always records the release URL.
 */
export async function syncHcs(options: { version: string; digest: string; root: string; url?: string }): Promise<{ dir: string; files: number; pin: HcsPin }> {
  const { version, digest, root } = options;
  if (!VERSION.test(version)) throw new UsageError(`not a release version: '${version}'`);
  if (contractVersion(version) !== HCS_VERSION) throw new UsageError(`${version} is not a release of contract ${HCS_VERSION}; change HCS_VERSION first`);
  if (!SHA256.test(digest)) throw new UsageError(`not a lowercase sha256 digest: '${digest}'`);
  const tarball = await download(options.url ?? releaseUrl(version));
  const actual = sha256(tarball);
  if (actual !== digest) throw new Error(`the downloaded tarball has sha256 ${actual}, the pin says ${digest}: refused`);
  const files = unpackRelease(tarball, version);
  const count = verifyFiles(files);

  const vendor = vendorDir(root);
  const pin: HcsPin = { version, sha256: digest, url: releaseUrl(version) };
  const dir = releaseDir(root, pin);
  const staging = join(vendor, `.staging-${version}-${process.pid}`);
  mkdirSync(vendor, { recursive: true });
  try {
    for (const [name, bytes] of files) {
      const target = join(staging, ...name.split('/'));
      mkdirSync(join(target, '..'), { recursive: true });
      writeFileSync(target, bytes);
    }
    verifyTree(staging);
    rmSync(dir, { recursive: true, force: true });
    renameSync(staging, dir);
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
  writeFileSync(join(vendor, PIN_FILE), `${JSON.stringify(pin, null, 2)}\n`);
  return { dir, files: count, pin };
}
