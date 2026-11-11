// Canonical JSON of HCS-0007 section 4: RFC 8785 (JCS) restricted to integers, plus a strict parser.
// `JSON.parse` keeps the last of two members with the same name and accepts unpaired surrogates, so a document that
// has no canonical form would still verify; signed documents are therefore read with `parseStrictJson`.

/** The value or text has no canonical form (HCS-0007 section 4, R004). */
export class CanonicalError extends TypeError {
  override name = 'CanonicalError';
  /** True when the cause is a number outside the integer domain (HCS-0007-R004). */
  outOfDomainNumber = false;
}

export const DEFAULT_MAX_DEPTH = 64;

const STRING = /"(?:[^"\\\u0000-\u001f]|\\(?:["\\/bfnrt]|u[0-9a-fA-F]{4}))*"/y;
const NUMBER = /-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/y;
const WHITESPACE = /[ \t\n\r]*/y;

const checkNumber = (value: number) => {
  if (Number.isSafeInteger(value)) return;
  const error = new CanonicalError('Number is not an integer between -(2^53-1) and 2^53-1');
  error.outOfDomainNumber = true;
  throw error;
};
const checkString = (value: string) => {
  if (!value.isWellFormed()) throw new CanonicalError('String has an unpaired surrogate');
};

/**
 * Parses JSON text into values of the canonical domain. Throws `CanonicalError` on anything `canonicalize` could not
 * serialise back unambiguously: invalid JSON or UTF-8, a duplicated member name, an unpaired surrogate, a number that
 * is not a safe integer, or nesting deeper than `maxDepth`.
 */
export function parseStrictJson(input: string | Uint8Array, maxDepth = DEFAULT_MAX_DEPTH): unknown {
  let text: string;
  if (typeof input === 'string') text = input;
  else {
    try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(input); }
    catch { throw new CanonicalError('Document is not valid UTF-8'); }
  }
  let at = 0;
  const fail = (message: string): never => { throw new CanonicalError(`${message} at offset ${at}`); };
  const match = (pattern: RegExp) => {
    pattern.lastIndex = at;
    const found = pattern.exec(text);
    if (found) at = pattern.lastIndex;
    return found?.[0];
  };
  const skip = () => { match(WHITESPACE); };
  const string = () => {
    const token = match(STRING);
    if (token === undefined) return fail('Expected a string');
    const value = JSON.parse(token) as string;
    checkString(value);
    return value;
  };
  const value = (depth: number): unknown => {
    skip();
    const ch = text[at];
    if (ch === '{' || ch === '[') {
      if (depth >= maxDepth) fail('Document exceeds the depth limit');
      at++;
      return ch === '{' ? object(depth + 1) : array(depth + 1);
    }
    if (ch === '"') return string();
    for (const [literal, result] of [['true', true], ['false', false], ['null', null]] as const) {
      if (text.startsWith(literal, at)) { at += literal.length; return result; }
    }
    const token = match(NUMBER);
    if (token === undefined) return fail('Expected a JSON value');
    const number = Number(token);
    checkNumber(number);
    return number;
  };
  const object = (depth: number) => {
    const result: Record<string, unknown> = {};
    skip();
    if (text[at] === '}') { at++; return result; }
    for (;;) {
      skip();
      const name = string();
      if (Object.hasOwn(result, name)) fail(`Duplicated member name ${JSON.stringify(name)}`);
      skip();
      if (text[at++] !== ':') { at--; fail('Expected ":"'); }
      // defineProperty so that a member named `__proto__` is an own property, as with JSON.parse.
      Object.defineProperty(result, name, { value: value(depth), enumerable: true, writable: true, configurable: true });
      skip();
      const next = text[at++];
      if (next === '}') return result;
      if (next !== ',') { at--; fail('Expected "," or "}"'); }
    }
  };
  const array = (depth: number) => {
    const result: unknown[] = [];
    skip();
    if (text[at] === ']') { at++; return result; }
    for (;;) {
      result.push(value(depth));
      skip();
      const next = text[at++];
      if (next === ']') return result;
      if (next !== ',') { at--; fail('Expected "," or "]"'); }
    }
  };
  const result = value(0);
  skip();
  if (at !== text.length) fail('Unexpected text after the document');
  return result;
}

/**
 * RFC 8785 serialization of a value of the canonical domain: members sorted by UTF-16 code units, no whitespace,
 * integers as decimal digits. Throws `CanonicalError` for a value outside the domain.
 */
export function canonicalize(value: unknown, maxDepth = DEFAULT_MAX_DEPTH): string {
  const write = (v: unknown, depth: number): string => {
    if (v === null || typeof v === 'boolean') return String(v);
    if (typeof v === 'string') { checkString(v); return JSON.stringify(v); }
    if (typeof v === 'number') { checkNumber(v); return String(v === 0 ? 0 : v); }
    if (typeof v !== 'object') throw new CanonicalError(`A ${typeof v} is not a JSON value`);
    if (depth >= maxDepth) throw new CanonicalError('Value exceeds the depth limit');
    if (Array.isArray(v)) {
      const items: string[] = [];
      // Indexed loop: a hole in a sparse array reads as undefined and is refused instead of skipped.
      for (let i = 0; i < v.length; i++) items.push(write(v[i], depth + 1));
      return `[${items.join(',')}]`;
    }
    const prototype = Object.getPrototypeOf(v) as unknown;
    if (prototype !== Object.prototype && prototype !== null) throw new CanonicalError('Only plain objects are JSON values');
    // The default sort compares UTF-16 code units, which is the order RFC 8785 section 3.2.3 asks for.
    const members = Object.keys(v).sort().map(name => { checkString(name); return `${JSON.stringify(name)}:${write((v as Record<string, unknown>)[name], depth + 1)}`; });
    return `{${members.join(',')}}`;
  };
  return write(value, 0);
}
