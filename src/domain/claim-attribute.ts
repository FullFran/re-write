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

/** Digits or simple Spanish number words up to 199 ("once", "cuarenta y dos", "ciento uno"); null otherwise. */
export function parseSpanishNumber(value: string | number): number | null {
  if (typeof value === 'number') return Number.isFinite(value) && value >= 0 ? value : null;
  const text = fold(value);
  if (/^\d+([.,]\d+)?$/.test(text)) return Number(text.replace(',', '.'));
  const words = text.split(' ');
  if (words[0] === 'cien' && words.length === 1) return 100;
  if (words[0] === 'ciento' && words.length > 1) {
    const rest = below100(words.slice(1));
    return rest === null ? null : 100 + rest;
  }
  return below100(words);
}

/** A date as comparable parts: [year, month?, day?]; a plain number is a single part. */
export function parseDate(value: string | number): number[] | null {
  if (typeof value === 'number') return Number.isFinite(value) ? [value] : null;
  const match = /^(-?\d{1,6})(?:-(\d{2})(?:-(\d{2}))?)?$/.exec(value.trim());
  if (!match) return null;
  const parts = [Number(match[1])];
  if (match[2]) parts.push(Number(match[2]));
  if (match[3]) parts.push(Number(match[3]));
  if ((parts[1] !== undefined && (parts[1] < 1 || parts[1] > 12)) || (parts[2] !== undefined && (parts[2] < 1 || parts[2] > 31))) return null;
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

/** Throws a reason when an attribute cannot be read, so the candidate is rejected and not stored. */
export function validateAttribute(attribute: unknown): void {
  const a = attribute as ClaimAttribute;
  if (typeof a !== 'object' || a === null) throw new Error('attribute must be an object with name and value');
  if (!ATTRIBUTE_NAMES.includes(a.name)) {
    throw new Error(`unknown attribute: ${String(a.name)}; expected one of ${ATTRIBUTE_NAMES.join(', ')}`);
  }
  if (typeof a.value !== 'string' && typeof a.value !== 'number') throw new Error(`attribute ${a.name} needs a value`);
  for (const key of ['unit', 'about'] as const) {
    if (a[key] !== undefined && typeof a[key] !== 'string') throw new Error(`attribute ${key} must be text`);
  }
  if (a.name === 'edad' || a.name === 'años_en') {
    if (parseSpanishNumber(a.value) === null || unitOf(a) === null) {
      throw new Error(`attribute ${a.name} needs a number of years, months, weeks or days, in digits or Spanish words: ${JSON.stringify(a.unit !== undefined && unitOf(a) === null ? a.unit : a.value)}`);
    }
  } else if (a.name === 'fecha') {
    if (parseDate(a.value) === null) throw new Error(`attribute fecha needs YYYY, YYYY-MM, YYYY-MM-DD or a number: ${JSON.stringify(a.value)}`);
  } else if (fold(String(a.value)) === '') {
    throw new Error('attribute lugar needs a place');
  }
}
