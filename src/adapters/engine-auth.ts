import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import type { IncomingHttpHeaders } from 'node:http';
import { join } from 'node:path';
import { parseCredential, type StoredCredential } from './engine-protocol.ts';

const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex');

/** Reads the 32-byte key that encrypts stored credentials (base64 or base64url). */
export function parseEngineKey(value: string | undefined): Buffer {
  const key = Buffer.from(value ?? '', 'base64');
  if (key.length !== 32) throw new Error('REWRITE_ENGINE_KEY must be 32 bytes, base64 encoded');
  return key;
}

/** The stored credential cannot be read: wrong key, damaged file or another person's file. */
export class VaultError extends Error {
  constructor() {
    super('stored credential is unreadable');
  }
}

/**
 * One encrypted file per person under the data directory. The file name is a hash of
 * the subject and the subject is bound into the ciphertext, so a file moved to another
 * person's name does not decrypt. Callers serialize writes per person.
 */
export class CredentialVault {
  private readonly dir: string;
  private readonly key: Buffer;

  constructor(dataDir: string, key: Buffer) {
    this.dir = join(dataDir, 'engine', 'credentials');
    this.key = key;
  }

  pathFor(subject: string): string {
    return join(this.dir, `${sha256(subject)}.json`);
  }

  read(subject: string): StoredCredential | null {
    let raw: string;
    try {
      raw = readFileSync(this.pathFor(subject), 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw new VaultError();
    }
    try {
      const file = JSON.parse(raw) as { v?: unknown; iv?: unknown; tag?: unknown; data?: unknown };
      if (file.v !== 1 || typeof file.iv !== 'string' || typeof file.tag !== 'string' || typeof file.data !== 'string') throw new Error();
      const decipher = createDecipheriv('aes-256-gcm', this.key, Buffer.from(file.iv, 'base64'));
      decipher.setAAD(Buffer.from(subject, 'utf8'));
      decipher.setAuthTag(Buffer.from(file.tag, 'base64'));
      const plain = Buffer.concat([decipher.update(Buffer.from(file.data, 'base64')), decipher.final()]).toString('utf8');
      const credential = parseCredential(JSON.parse(plain));
      if (!credential) throw new Error();
      return credential;
    } catch {
      // Never surface the cause: it could quote file content.
      throw new VaultError();
    }
  }

  write(subject: string, credential: StoredCredential): void {
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    chmodSync(this.dir, 0o700);
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    cipher.setAAD(Buffer.from(subject, 'utf8'));
    const data = Buffer.concat([cipher.update(JSON.stringify(credential), 'utf8'), cipher.final()]);
    const body = JSON.stringify({ v: 1, iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64') });
    const target = this.pathFor(subject);
    const temp = `${target}.${randomBytes(6).toString('hex')}.tmp`;
    try {
      writeFileSync(temp, body, { mode: 0o600, flag: 'wx' });
      renameSync(temp, target);
    } catch (error) {
      rmSync(temp, { force: true });
      throw error;
    }
  }

  delete(subject: string): void {
    rmSync(this.pathFor(subject), { force: true });
  }
}

const TOKEN_PREFIX = 'rwe_';

/**
 * Bearers the server gives its own engine processes for the MCP door. They are random,
 * kept only as a SHA-256 hash in memory, and are not JWTs, so no token verifier accepts
 * one: the review door stays closed to them.
 */
export class EngineTokens {
  private readonly live = new Map<string, { subject: string; expires: number }>();

  mint(subject: string, ttlMs: number): string {
    // base64url has no `$` and the value never starts with `!`, so an MCP client that
    // expands variables or commands in header values finds nothing to expand.
    const token = `${TOKEN_PREFIX}${randomBytes(32).toString('base64url')}`;
    this.live.set(sha256(token), { subject, expires: Date.now() + ttlMs });
    return token;
  }

  /** The person a live token was minted for, found by hash and never by comparing secrets. */
  resolve(token: string): string | null {
    if (!token.startsWith(TOKEN_PREFIX)) return null;
    const hash = sha256(token);
    const entry = this.live.get(hash);
    if (!entry) return null;
    if (entry.expires <= Date.now()) {
      this.live.delete(hash);
      return null;
    }
    return entry.subject;
  }

  revoke(token: string): void {
    this.live.delete(sha256(token));
  }
}

export function looksLikeEngineToken(token: string | null): boolean {
  return token !== null && token.startsWith(TOKEN_PREFIX);
}

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
const PROXY_HEADERS = ['forwarded', 'x-forwarded-for', 'x-real-ip'];

/**
 * An engine token is only honoured on a direct loopback connection. A reverse proxy on
 * the same host also connects from loopback, so a request that carries any proxy header
 * is treated as coming from outside.
 */
export function isDirectLoopback(remoteAddress: string | undefined, headers: IncomingHttpHeaders): boolean {
  if (!remoteAddress || !LOOPBACK.has(remoteAddress)) return false;
  return PROXY_HEADERS.every((name) => headers[name] === undefined);
}
