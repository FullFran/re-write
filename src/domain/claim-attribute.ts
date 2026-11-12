/**
 * Optional structured attribute on a claim, so continuity checks can compare ages, durations,
 * dates and places without reading prose. Older claims have none and are simply not checked.
 */
export const ATTRIBUTE_NAMES = ['edad', 'años_en', 'lugar', 'fecha'] as const;
export type AttributeName = (typeof ATTRIBUTE_NAMES)[number];

export interface ClaimAttribute {
  /** edad: an age; años_en: how long something has lasted; lugar: where a thing that does not move is; fecha: when it happens. */
  name: AttributeName;
  /** A number, digits or simple Spanish number words for edad and años_en; a stable key for lugar; YYYY[-MM[-DD]] or a number for fecha. */
  value: string | number;
  /** Unit of edad and años_en: años (the default), meses, semanas or días. */
  unit?: string;
  /** What the value is about, kept stable across claims, for example "puente de Sal" for años_en. */
  about?: string;
}

const UNITS: Record<string, string> = {
  ano: 'años', anos: 'años', mes: 'meses', meses: 'meses', semana: 'semanas', semanas: 'semanas', dia: 'días', dias: 'días',
};

const ONES: Record<string, number> = {
  cero: 0, un: 1, uno: 1, una: 1, dos: 2, tres: 3, cuatro: 4, cinco: 5, seis: 6, siete: 7, ocho: 8, nueve: 9,
  diez: 10, once: 11, doce: 12, trece: 13, catorce: 14, quince: 15, dieciseis: 16, diecisiete: 17, dieciocho: 18,
  diecinueve: 19, veinte: 20, veintiun: 21, veintiuno: 21, veintiuna: 21, veintidos: 22, veintitres: 23,
  veinticuatro: 24, veinticinco: 25, veintiseis: 26, veintisiete: 27, veintiocho: 28, veintinueve: 29,
};
const TENS: Record<string, number> = {
  treinta: 30, cuarenta: 40, cincuenta: 50, sesenta: 60, setenta: 70, ochenta: 80, noventa: 90,
};

/** Lower case, no accents, single spaces: how names, places and keys are compared. */
export function fold(text: string): string {
  return text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/\s+/g, ' ').trim();
}

function below100(words: string[]): number | null {
  if (words.length === 1) return ONES[words[0]] ?? TENS[words[0]] ?? null;
  if (words.length === 3 && words[1] === 'y' && TENS[words[0]] !== undefined) {
    const unit = ONES[words[2]];
    return unit !== undefined && unit >= 1 && unit <= 9 ? TENS[words[0]] + unit : null;
  }
  return null;
}

/** The largest age or duration read, in any unit. */
export const MAX_AMOUNT = 200;
/** The longest text an attribute field may hold. */
export const MAX_ATTRIBUTE_TEXT = 120;
const MAX_DATE_NUMBER = 999_999;

/**
 * A whole number from 0 to 200, as digits or simple Spanish number words ("once", "cuarenta y dos",
 * "ciento uno"); null otherwise. Digits take no separators: "1.000" and "1,5" are refused rather than
 * guessed, because in Spanish the dot groups thousands and the comma marks decimals.
 */
export function parseSpanishNumber(value: string | number): number | null {
  let n: number | null;
  if (typeof value === 'number') n = value;
  else {
    const text = fold(value);
    const words = text.split(' ');
    const rest = words[0] === 'ciento' && words.length > 1 ? below100(words.slice(1)) : null;
    n = /^\d{1,3}$/.test(text) ? Number(text)
      : words[0] === 'cien' && words.length === 1 ? 100
      : words[0] === 'ciento' ? (rest === null ? null : 100 + rest)
      : below100(words);
  }
  return n !== null && Number.isInteger(n) && n >= 0 && n <= MAX_AMOUNT ? n : null;
}

const daysIn = (year: number, month: number) => [31, (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0 ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];

/** A real calendar date as comparable parts: [year, month?, day?]; a whole number is a single part. */
export function parseDate(value: string | number): number[] | null {
  if (typeof value === 'number') return Number.isInteger(value) && Math.abs(value) <= MAX_DATE_NUMBER ? [value] : null;
  const match = /^(-?\d{1,6})(?:-(\d{2})(?:-(\d{2}))?)?$/.exec(value.trim());
  if (!match) return null;
  const parts = [Number(match[1])];
  if (match[2]) parts.push(Number(match[2]));
  if (match[3]) parts.push(Number(match[3]));
  if (parts[1] !== undefined && (parts[1] < 1 || parts[1] > 12)) return null;
  if (parts[2] !== undefined && (parts[2] < 1 || parts[2] > daysIn(parts[0], parts[1]))) return null;
  return parts;
}

/** Compares the parts both dates have, so "1888" and "1888-03-04" are neither before nor after each other. */
export function compareDates(a: number[], b: number[]): number {
  for (let i = 0; i < Math.min(a.length, b.length); i++) if (a[i] !== b[i]) return a[i] - b[i];
  return 0;
}

export function unitOf(attribute: ClaimAttribute): string | null {
  return attribute.unit === undefined ? 'años' : UNITS[fold(attribute.unit)] ?? null;
}

const KEYS = ['name', 'value', 'unit', 'about'] as const;
const UNSAFE = /[\p{Cc}\p{Cf}]/u;

function cleanText(key: string, value: unknown): string {
  if (typeof value !== 'string') throw new Error(`attribute ${key} must be text`);
  if (value.length > MAX_ATTRIBUTE_TEXT) throw new Error(`attribute ${key} must be at most ${MAX_ATTRIBUTE_TEXT} characters`);
  if (UNSAFE.test(value)) throw new Error(`attribute ${key} must not contain control or format characters`);
  const trimmed = value.trim();
  if (!trimmed) throw new Error(`attribute ${key} must not be empty`);
  return trimmed;
}

/**
 * The one check for an attribute, on every path that stores claims (MCP and annotation imports). It
 * returns a clean copy with only the known keys, or throws a reason so the candidate is rejected and
 * nothing about it is stored.
 */
export function validateAttribute(attribute: unknown): ClaimAttribute {
  if (typeof attribute !== 'object' || attribute === null || Array.isArray(attribute)) {
    throw new Error('attribute must be an object with name and value');
  }
  const unknown = Object.keys(attribute).filter((key) => !(KEYS as readonly string[]).includes(key));
  if (unknown.length) throw new Error(`attribute has unknown keys: ${unknown.join(', ')}; expected ${KEYS.join(', ')}`);
  const a = attribute as Record<string, unknown>;
  const name = a.name as AttributeName;
  if (!ATTRIBUTE_NAMES.includes(name)) {
    throw new Error(`unknown attribute: ${typeof a.name === 'string' ? cleanText('name', a.name) : String(a.name)}; expected one of ${ATTRIBUTE_NAMES.join(', ')}`);
  }
  if (typeof a.value !== 'string' && typeof a.value !== 'number') throw new Error(`attribute ${name} needs a value`);
  const value = typeof a.value === 'string' ? cleanText('value', a.value) : a.value;
  const clean: ClaimAttribute = { name, value };
  if (a.unit !== undefined) clean.unit = cleanText('unit', a.unit);
  if (a.about !== undefined) clean.about = cleanText('about', a.about);
  if (name === 'edad' || name === 'años_en') {
    if (unitOf(clean) === null) throw new Error(`attribute unit must be años, meses, semanas or días: ${JSON.stringify(clean.unit)}`);
    if (parseSpanishNumber(value) === null) {
      throw new Error(`attribute ${name} needs a whole number from 0 to ${MAX_AMOUNT}, in digits without separators or simple Spanish words: ${JSON.stringify(value)}`);
    }
  } else if (name === 'fecha') {
    if (parseDate(value) === null) throw new Error(`attribute fecha needs a real date as YYYY, YYYY-MM or YYYY-MM-DD, or a whole number: ${JSON.stringify(value)}`);
  }
  return clean;
}

/** Same name, value, unit and about. */
export function sameAttribute(a: ClaimAttribute, b: ClaimAttribute): boolean {
  return KEYS.every((key) => a[key] === b[key]);
}
