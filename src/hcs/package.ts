import { createHash, randomBytes } from 'node:crypto';
import { chmodSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, posix } from 'node:path';
import { gzipSync, gunzipSync } from 'node:zlib';
import { HcsFailure, hcsError } from './errors.ts';
import { readTar, writeTar, TarFormatError, TarUnsafeNameError, type TarInput, type TarMember } from './tar.ts';

export interface PackageExpected { size: number; contentHash: string; contentId?: string }
export interface PackageLimits { maxBytes?: number; maxMembers?: number }
const mediaType = 'application/vnd.oci.image.layer.v1.tar+gzip';
const hashPattern = /^(sha256:[a-f0-9]{64}|sha512:[a-f0-9]{128})$/;
function failure(message: string): never { throw new HcsFailure([hcsError('integrity_mismatch', message, { requirement: 'HCS-0001-R007' })]); }
// Every refusal caused by the package's bytes is an `integrity_mismatch`: the bytes are not the
// package the catalog promised a host can unpack. `x-rewrite-archive` says which kind of refusal.
function unsafe(name: string, reason: string): never {
  throw new HcsFailure([hcsError('integrity_mismatch', 'Unsafe archive member', { details: { 'x-rewrite-archive': 'unsafe-member', 'x-rewrite-member': name, 'x-rewrite-reason': reason } })]);
}
function malformed(reason: string, message: string): never {
  throw new HcsFailure([hcsError('integrity_mismatch', `Malformed package archive: ${message}`, { details: { 'x-rewrite-archive': 'malformed', 'x-rewrite-reason': reason } })]);
}
function overLimit(reason: string, message: string): never {
  throw new HcsFailure([hcsError('integrity_mismatch', message, { details: { 'x-rewrite-archive': 'limit-exceeded', 'x-rewrite-reason': reason } })]);
}
export function buildPackage(dir: string) {
  const members: TarInput[] = [];
  function walk(path: string, prefix: string) {
    for (const name of readdirSync(path)) {
      const full = join(path, name), relative = prefix ? `${prefix}/${name}` : name;
      const stat = lstatSync(full);
      if (stat.isDirectory()) { members.push({ name: relative, type: 'directory' }); walk(full, relative); }
      else if (stat.isFile()) members.push({ name: relative, data: readFileSync(full) });
      else throw new Error(`Unsupported source member: ${relative}`);
    }
  }
  if (!lstatSync(dir).isDirectory()) throw new Error('Package source must be a directory');
  walk(dir, ''); const bytes = gzipSync(writeTar(members), { level: 9 });
  return { bytes, contentHash: `sha256:${createHash('sha256').update(bytes).digest('hex')}`, size: bytes.length, mediaType };
}
// Default bound on the decompressed stream: the default unpack limits (256 MiB of data, 10,000 members).
const defaultMaxUncompressedBytes = 256 * 1024 * 1024 + 10000 * 1023 + 1024;
// Transport size, transport digest, then (when the entry declares `contentId`) the digest of the exact uncompressed
// tar stream under a bound on that stream (HCS-0001-R018). Returns the tar when it had to be decompressed.
function verifyTransportAndIdentity(bytes: Uint8Array, expected: PackageExpected, maxUncompressedBytes: number): Buffer | undefined {
  if (bytes.length !== expected.size) failure('Package size does not match');
  if (!hashPattern.test(expected.contentHash)) failure('Invalid package content hash');
  const [algorithm, digest] = expected.contentHash.split(':');
  if (createHash(algorithm).update(bytes).digest('hex') !== digest) failure('Package digest does not match');
  if (expected.contentId === undefined) return undefined;
  const identity = (message: string): never => { throw new HcsFailure([hcsError('integrity_mismatch', message, { requirement: 'HCS-0001-R018' })]); };
  if (typeof expected.contentId !== 'string' || !hashPattern.test(expected.contentId)) identity('Invalid package content id');
  let tar: Buffer;
  try { tar = gunzipSync(bytes, { maxOutputLength: Math.max(1, maxUncompressedBytes) }); }
  catch { return identity('Package cannot be decompressed within the limit'); }
  if (tar.length > maxUncompressedBytes) identity('Package cannot be decompressed within the limit');
  const [idAlgorithm, idDigest] = expected.contentId.split(':');
  if (createHash(idAlgorithm).update(tar).digest('hex') !== idDigest) identity('Package content id does not match');
  return tar;
}
export function verifyPackage(bytes: Uint8Array, expected: PackageExpected, limits: { maxUncompressedBytes?: number } = {}): void {
  const max = limits.maxUncompressedBytes ?? defaultMaxUncompressedBytes;
  if (!Number.isSafeInteger(max) || max < 0) throw new RangeError('Invalid package limits');
  verifyTransportAndIdentity(bytes, expected, Math.min(max, 0x7fffffff));
}
/**
 * The members of the archive in package bytes whose size and digest were already verified, read
 * without unpacking anything. `tar` is the stream when it was already decompressed (a declared
 * `contentId` was verified). A refusal caused by the bytes (not gzip, over `maxUncompressedBytes`,
 * a malformed tar, a name with bytes after NUL) is an HcsFailure with `integrity_mismatch`.
 */
export function readPackageMembers(bytes: Uint8Array, maxUncompressedBytes: number, tar?: Buffer): TarMember[] {
  let stream = tar;
  if (stream === undefined) {
    try { stream = gunzipSync(bytes, { maxOutputLength: Math.max(1, maxUncompressedBytes) }); } catch (error: any) {
      if (error?.code === 'ERR_BUFFER_TOO_LARGE') overLimit('uncompressed size limit', 'Package cannot be decompressed within the limit');
      malformed('invalid gzip stream', 'Package is not a gzip stream');
    }
  }
  try { return readTar(stream); } catch (error) {
    if (error instanceof TarUnsafeNameError) unsafe(error.memberName, 'invalid path');
    if (error instanceof TarFormatError) malformed(error.reason, error.message);
    throw error;
  }
}
export function sealTree(dir: string): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) sealTree(path);
    else if (entry.isFile()) chmodSync(path, 0o444);
    else throw new Error('Cannot seal non-regular member');
  }
  chmodSync(dir, 0o555);
}
// lstat, not existsSync: a dangling symlink at the target must also count as taken.
function taken(path: string): boolean {
  try { lstatSync(path); return true; } catch (error: any) { if (error.code === 'ENOENT') return false; throw error; }
}
function unsealTree(dir: string): void {
  chmodSync(dir, 0o700);
  for (const entry of readdirSync(dir, { withFileTypes: true })) if (entry.isDirectory()) unsealTree(join(dir, entry.name));
}
export function unpackPackage(bytes: Uint8Array, expected: PackageExpected, targetDir: string, limits: PackageLimits = {}): void {
  const maxBytes = limits.maxBytes ?? 256 * 1024 * 1024, maxMembers = limits.maxMembers ?? 10000;
  const validLimits = Number.isSafeInteger(maxBytes) && maxBytes >= 0 && Number.isSafeInteger(maxMembers) && maxMembers >= 0;
  // Allow each member a header and up to one padding block, plus the terminator.
  const cap = validLimits ? Math.min(maxBytes + maxMembers * 1023 + 1024, 0x7fffffff) : defaultMaxUncompressedBytes;
  const verifiedTar = verifyTransportAndIdentity(bytes, expected, cap);
  if (!validLimits) throw new RangeError('Invalid package limits');
  if (taken(targetDir)) throw new Error('Package target already exists');
  const members = readPackageMembers(bytes, cap, verifiedTar);
  if (members.length > maxMembers) overLimit('member limit', 'Package member limit exceeded');
  let total = 0; const names = new Set<string>(), files = new Set<string>();
  for (const member of members) {
    const name = member.name;
    if (!name || name.startsWith('/') || name.includes('\\') || name.includes('\0') || name.split('/').includes('..')) unsafe(name, 'invalid path');
    const normalized = posix.normalize(name).replace(/\/$/, '');
    if (!normalized || normalized === '.' || names.has(normalized)) unsafe(name, 'duplicate or empty path');
    names.add(normalized);
    if (member.type === '0') files.add(normalized);
    if (name.split('/').some(part => part.startsWith('.wh.'))) unsafe(name, 'whiteout');
    if (member.type !== '0' && member.type !== '5') unsafe(name, 'unsupported type');
    if (member.type === '5' && member.size !== 0) unsafe(name, 'directory data');
    total += member.size; if (total > maxBytes) overLimit('size limit', 'Package size limit exceeded');
  }
  // A member below a regular file cannot be written, whichever comes first in the archive.
  for (const member of members) {
    const parts = posix.normalize(member.name).replace(/\/$/, '').split('/');
    for (let i = 1; i < parts.length; i++) if (files.has(parts.slice(0, i).join('/'))) unsafe(member.name, 'path conflict');
  }
  const partial = `${targetDir}.partial-${randomBytes(16).toString('hex')}`;
  mkdirSync(partial, { mode: 0o700 });
  try {
    for (const member of members) {
      const dest = join(partial, member.name);
      if (member.type === '5') mkdirSync(dest, { recursive: true });
      else { mkdirSync(dirname(dest), { recursive: true }); writeFileSync(dest, member.data, { flag: 'wx' }); }
    }
    sealTree(partial);
    // Callers that share a state directory serialize through the host lock (#29), so no writer races this check.
    if (taken(targetDir)) throw new Error('Package target already exists');
    renameSync(partial, targetDir);
  } catch (error) { unsealTree(partial); rmSync(partial, { recursive: true, force: true }); throw error; }
}
// Package bytes come only from the content-addressed store or an `https:` location; any other
// location (including `file:`) is refused like an unavailable one. Aborting `signal` aborts the download.
export async function fetchPackageBytes(entry: PackageExpected & { locations?: string[] }, options: { storeDir: string; signal?: AbortSignal }): Promise<Buffer> {
  if (!hashPattern.test(entry.contentHash)) throw new Error('Invalid package content hash');
  const [algorithm, digest] = entry.contentHash.split(':');
  try { return readFileSync(join(options.storeDir, algorithm, digest)); } catch (error: any) { if (error.code !== 'ENOENT') throw error; }
  let lastError: unknown = new Error('No package location available');
  for (const location of entry.locations ?? []) {
    try {
      const url = new URL(location);
      if (url.protocol !== 'https:') throw new Error('Unsupported package location');
      options.signal?.throwIfAborted();
      const controller = new AbortController();
      const abort = () => controller.abort(options.signal?.reason);
      options.signal?.addEventListener('abort', abort, { once: true });
      try {
        const response = await fetch(url, { signal: controller.signal, redirect: 'error' });
        if (!response.ok || !response.body) throw new Error(`Package fetch failed: ${response.status}`);
        const chunks: Buffer[] = []; let length = 0;
        for await (const chunk of response.body) { length += chunk.length; if (length > entry.size) { controller.abort(); throw new Error('Package download exceeds expected size'); } chunks.push(Buffer.from(chunk)); }
        return Buffer.concat(chunks, length);
      } finally { options.signal?.removeEventListener('abort', abort); controller.abort(); }
    } catch (error) { if (options.signal?.aborted) throw error; lastError = error; }
  }
  throw lastError;
}
