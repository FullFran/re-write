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
const NUMBER = /-?(0|[1-9][0-9]*)(?:\.([0-9]+))?(?:[eE]([+-]?[0-9]+))?/y;
const WHITESPACE = /[ \t\n\r]*/y;

const NOT_AN_INTEGER = 'Number is not an integer between -(2^53-1) and 2^53-1';
const numberError = (message = NOT_AN_INTEGER) => {
  const error = new CanonicalError(message);
  error.outOfDomainNumber = true;
  return error;
};
const checkNumber = (value: number) => { if (!Number.isSafeInteger(value)) throw numberError(); };
const checkString = (value: string) => {
  if (!value.isWellFormed()) throw new CanonicalError('String has an unpaired surrogate');
};

// Whether the exact decimal value of a JSON number token is an integer of the safe range. Decided on the digits:
// `Number("1.0000000000000000001")` is 1 and `Number("1e-400")` is 0, and neither token is an integer.
function isSafeIntegerToken(integerDigits: string, fractionDigits = '', exponent = '0'): boolean {
  const digits = (integerDigits + fractionDigits).replace(/^0+/, '');
  if (digits === '') return true;
  // The value is `digits` times ten to the `scale`. A huge exponent loses precision as a double and stays huge.
  const scale = Number(exponent) - fractionDigits.length;
  let magnitude: string;
  if (scale >= 0) {
    if (digits.length + scale > 16) return false;
    magnitude = digits + '0'.repeat(scale);
  } else {
    if (-scale >= digits.length || /[1-9]/.test(digits.slice(scale))) return false;
    magnitude = digits.slice(0, scale);
    if (magnitude.length > 16) return false;
  }
  return BigInt(magnitude) <= BigInt(Number.MAX_SAFE_INTEGER);
}

/**
 * Parses JSON text into values of the canonical domain. Throws `CanonicalError` on anything `canonicalize` could not
 * serialise back unambiguously: invalid JSON or UTF-8, a duplicated member name, an unpaired surrogate, a number that
 * is not a safe integer, or nesting deeper than `maxDepth`. Messages carry an offset, never text of the document.
 */
export function parseStrictJson(input: string | Uint8Array, maxDepth = DEFAULT_MAX_DEPTH): unknown {
  const { value, numberError: error } = readStrictJson(input, maxDepth);
  if (error) throw error;
  return value;
}

/**
 * `parseStrictJson` for a caller that must look at the document before applying the number rule (HCS-0007-R001
 * reports an unsupported version first). The first number outside the integer domain is returned as `numberError`
 * instead of thrown, and every such number reads as `null` in `value`: check `numberError` before trusting `value`.
 */
export function readStrictJson(input: string | Uint8Array, maxDepth = DEFAULT_MAX_DEPTH): { value: unknown; numberError?: CanonicalError } {
  let text: string;
  if (typeof input === 'string') text = input;
  else {
    try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(input); }
    catch { throw new CanonicalError('Document is not valid UTF-8'); }
  }
  let at = 0;
  let firstNumberError: CanonicalError | undefined;
  const fail = (message: string, offset = at): never => { throw new CanonicalError(`${message} at offset ${offset}`); };
  const match = (pattern: RegExp) => {
    pattern.lastIndex = at;
    const found = pattern.exec(text);
    if (found) at = pattern.lastIndex;
    return found;
  };
  const skip = () => { match(WHITESPACE); };
  const string = () => {
    const start = at;
    const token = match(STRING)?.[0];
    if (token === undefined) return fail('Expected a string');
    const value = JSON.parse(token) as string;
    if (!value.isWellFormed()) fail('String has an unpaired surrogate', start);
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
    if (ch === 't' && text.startsWith('true', at)) { at += 4; return true; }
    if (ch === 'f' && text.startsWith('false', at)) { at += 5; return false; }
    if (ch === 'n' && text.startsWith('null', at)) { at += 4; return null; }
    const start = at;
    const token = match(NUMBER);
    if (token === null) return fail('Expected a JSON value');
    // Number() is exact for a token whose exact value is a safe integer, and keeps the sign of -0 as JSON.parse does.
    if (isSafeIntegerToken(token[1], token[2], token[3])) return Number(token[0]);
    firstNumberError ??= numberError(`${NOT_AN_INTEGER} at offset ${start}`);
    return null;
  };
  const object = (depth: number) => {
    const result: Record<string, unknown> = {};
    skip();
    if (text[at] === '}') { at++; return result; }
    for (;;) {
      skip();
      const start = at;
      const name = string();
      if (Object.hasOwn(result, name)) fail('Duplicated member name', start);
      skip();
      if (text[at++] !== ':') { at--; fail('Expected ":"'); }
      // defineProperty so that a member named `__proto__` is an own property, as with JSON.parse.
      if (name === '__proto__') Object.defineProperty(result, name, { value: value(depth), enumerable: true, writable: true, configurable: true });
      else result[name] = value(depth);
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
  return { value: result, numberError: firstNumberError };
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
