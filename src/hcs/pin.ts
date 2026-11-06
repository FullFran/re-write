import { join } from 'node:path';
import { HCS_VERSION } from './version.ts';

export interface HcsPin {
  hcsVersion: string;
  repository: string;
  commit: string;
}

export function parsePin(contents: string): HcsPin {
  let pin: unknown;
  try { pin = JSON.parse(contents); } catch { throw new Error('HCS pin is malformed JSON'); }
  if (!pin || typeof pin !== 'object' || Array.isArray(pin)) throw new Error('HCS pin must be an object');
  const { hcsVersion, repository, commit } = pin as Record<string, unknown>;
  if (hcsVersion !== HCS_VERSION) throw new Error(`HCS pin version must match ${HCS_VERSION}`);
  if (typeof repository !== 'string' || !/^[\w.-]+\/[\w.-]+$/.test(repository)) throw new Error('HCS pin repository must be owner/name');
  if (typeof commit !== 'string' || !/^[0-9a-f]{40}$/.test(commit)) throw new Error('HCS pin commit must be 40 lowercase hexadecimal characters');
  return { hcsVersion, repository, commit };
}

export function targetPath(root: string, pin: HcsPin): string {
  return join(root, '.hcs', pin.commit);
}
