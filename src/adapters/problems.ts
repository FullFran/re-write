const BASE = 'https://github.com/FullFran/re-write/blob/main/docs/problems.md#';

export const PRODUCT_PROBLEMS = {
  'unknown-book': 'Unknown book',
  'not-found': 'Not found',
  'quote-not-literal': 'Text not literal',
  'stale-evidence': 'Stale evidence',
  'conflict': 'Conflict',
  'invalid-input': 'Invalid input',
  'unauthorized': 'Unauthorized',
  'forbidden': 'Forbidden',
  'method-not-allowed': 'Method not allowed',
  'body-too-large': 'Body too large',
  'internal-error': 'Internal error',
} as const;
export type ProductProblemKind = keyof typeof PRODUCT_PROBLEMS;

export function rejectedCandidate<T extends { reason: string }>(rejection: T) {
  return { ...rejection, problem: productProblem(rejection.reason, 400) };
}

/** Classify existing domain refusals without turning them into HCS errors. */
export function productProblem(detail: string, status: number, kind?: ProductProblemKind) {
  const selected = kind ?? (
    /unknown book/i.test(detail) ? 'unknown-book' :
    /evidence is (stale|orphaned)|changed since/i.test(detail) ? 'stale-evidence' :
    /quote (not found|appears|is empty)|text to change (was not found|appears)/i.test(detail) ? 'quote-not-literal' :
    status === 401 ? 'unauthorized' : status === 403 ? 'forbidden' :
    status === 404 ? 'not-found' : status === 405 ? 'method-not-allowed' :
    status === 413 ? 'body-too-large' : status === 500 ? 'internal-error' :
    status === 409 ? 'conflict' : 'invalid-input'
  );
  return { type: `${BASE}${selected}`, title: PRODUCT_PROBLEMS[selected], status, detail };
}
