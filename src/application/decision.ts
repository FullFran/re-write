import { evaluate } from '../hcs/authority.ts';
import { HcsFailure, type HcsError } from '../hcs/errors.ts';
import { readGrants } from '../hcs/grants.ts';
import { BOOK_CREATE, REVIEW_DECIDE, REWRITE_PERMISSIONS } from '../hcs/ids.ts';
import type { Library } from './library.ts';

/** The two doors of the server: agents through the MCP, people through the review page. */
export type Door = 'mcp' | 'review';

export interface DecisionRequest {
  library: Library;
  /** The authenticated person. */
  subject: string;
  /** The book the operation touches, or null for listing the person's own books. */
  book: string | null;
  door: Door;
  permission: string;
  /** The package entry acting, or null for a host built-in called by the person's agent or browser. */
  entry: string | null;
}

export type BookDecision =
  | { allow: true }
  | { allow: false; reason: 'unknown-book' }
  | { allow: false; reason: 'permission-denied'; error: HcsError }
  | { allow: false; reason: 'forbidden'; detail: string };

const MCP_PERMISSIONS: readonly string[] = REWRITE_PERMISSIONS;
const REVIEW_PERMISSIONS: readonly string[] = [
  REVIEW_DECIDE,
  'com.fullfran.rewrite.book.read',
  'com.fullfran.rewrite.book.import',
  BOOK_CREATE,
];

/**
 * The single decision point for (subject, book, entry, permission). Everything is read at call
 * time, so revoking a person's book access or a package grant applies to the next call
 * (HCS-0005-R003). Allowed only when the person may use the book, the permission is reachable
 * through the door (review decisions only on the review door, and only by a person), and, when a
 * package acts, it holds a grant for that permission (HCS-0005-R001).
 */
export function decide(request: DecisionRequest): BookDecision {
  const { library, subject, book, door, permission, entry } = request;
  // Checked first, and with the same answer as a missing book, so book existence is not leaked.
  if (book !== null && !library.canUse(book, subject)) return { allow: false, reason: 'unknown-book' };
  const reachable = door === 'review' ? entry === null && REVIEW_PERMISSIONS.includes(permission) : MCP_PERMISSIONS.includes(permission);
  if (!reachable) return { allow: false, reason: 'forbidden', detail: `forbidden: ${permission} is not available through the ${door} door` };
  if (entry !== null) {
    const decision = evaluate({ entry, permission }, readGrants(library.dataDir));
    if (!decision.allow) return { allow: false, reason: 'permission-denied', error: decision.error };
  }
  return { allow: true };
}

/** A product refusal: the operation is not reachable through this door. */
export class ForbiddenError extends Error {
  readonly status = 403;
  constructor(detail: string) {
    super(detail);
    this.name = 'ForbiddenError';
  }
}

/**
 * Throws the refusal for a denied decision: the existing `unknown book` product refusal, an HCS
 * `permission_denied` failure, or a ForbiddenError.
 */
export function enforce(request: DecisionRequest): void {
  const decision = decide(request);
  if (decision.allow) return;
  if (decision.reason === 'unknown-book') throw new Error('unknown book');
  if (decision.reason === 'permission-denied') throw new HcsFailure([decision.error]);
  throw new ForbiddenError(decision.detail);
}
