import { isExtensionName } from './ids.ts';

export function partitionMembers(obj: Record<string, unknown>): {
  core: Record<string, unknown>; extensions: Record<string, unknown>; invalidExtensionNames: string[];
} {
  const core: Record<string, unknown> = {};
  const extensions: Record<string, unknown> = {};
  const invalidExtensionNames: string[] = [];
  for (const [key, value] of Object.entries(obj)) {
    if (isExtensionName(key)) Object.defineProperty(extensions, key, { value, enumerable: true, writable: true, configurable: true });
    else if (key.startsWith('x-') || key.startsWith('x_')) invalidExtensionNames.push(key);
    else Object.defineProperty(core, key, { value, enumerable: true, writable: true, configurable: true });
  }
  return { core, extensions, invalidExtensionNames };
}

export function stripExtensions(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripExtensions);
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).filter(([key]) => !isExtensionName(key)).map(([key, member]) => [key, stripExtensions(member)]));
}

export function withExtensionsIgnored<T extends { valid: boolean; errors: unknown }>(validate: (doc: any) => T): (doc: unknown) => T {
  return doc => validate(stripExtensions(doc));
}
