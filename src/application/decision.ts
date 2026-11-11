import { randomUUID } from 'node:crypto';
import { evaluate, matching } from '../hcs/authority.ts';
import { writeDecisionRecord, type Decider } from '../hcs/decision-records.ts';
import { HcsFailure, hcsError, type HcsError } from '../hcs/errors.ts';
import { grantId, readGrants } from '../hcs/grants.ts';
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
  /**
   * The operation's identifier, never its content (for example the request id of the request log).
   * It goes into the decision record; the host generates one when the caller has none.
   */
  operation?: string;
}

export type BookDecision =
  | { allow: true }
  | { allow: false; reason: 'unknown-book' }
  | { allow: false; reason: 'permission-denied'; error: HcsError }
  | { allow: false; reason: 'forbidden'; detail: string };

/**
 * A person editing the text of a scene directly. Like review decisions it is reachable only
 * through the review door and only by a person: agents and packages propose, they never write.
 */
export const SCENE_EDIT = 'com.fullfran.rewrite.scene.edit';

const MCP_PERMISSIONS: readonly string[] = REWRITE_PERMISSIONS;
const REVIEW_PERMISSIONS: readonly string[] = [
  REVIEW_DECIDE,
  SCENE_EDIT,
  'com.fullfran.rewrite.book.read',
  'com.fullfran.rewrite.book.import',
  BOOK_CREATE,
];

/**
 * The single decision point for (subject, book, entry, permission). Everything is read at call
 * time, so revoking a person's book access or a package grant applies to the next call
 * (HCS-0005-R003). Allowed only when the person may use the book, the permission is reachable
 * through the door (review decisions only on the review door, and only by a person), and, when a
 * package acts, it holds a grant for that permission (HCS-0005-R001). Every decision a grant takes
 * part in is written to `<data-dir>/decisions.jsonl` before it is returned (HCS-0005-R010); when the
 * record cannot be written the operation is denied (HCS-0005-R012).
 */
export function decide(request: DecisionRequest): BookDecision {
  const { library, subject, book, door, permission, entry } = request;
  // Checked first, and with the same answer as a missing book, so book existence is not leaked.
  if (book !== null && !library.canUse(book, subject)) return { allow: false, reason: 'unknown-book' };
  const reachable = door === 'review' ? entry === null && REVIEW_PERMISSIONS.includes(permission) : MCP_PERMISSIONS.includes(permission);
  if (!reachable) return { allow: false, reason: 'forbidden', detail: `forbidden: ${permission} is not available through the ${door} door` };
  if (entry !== null) {
    const grants = readGrants(library.dataDir);
    const check = { entry, permission };
    const decision = evaluate(check, grants);
    const grant = matching(check, grants);
    const decider: Decider = decision.allow && grant ? { kind: 'grant', id: grantId(grant) } : { kind: 'policy', id: 'HCS-0005-R001' };
    try {
      writeDecisionRecord(library.dataDir, {
        entry, permission, outcome: decision.allow ? 'allow' : 'deny', operation: request.operation ?? randomUUID(), decider, channel: 'grant-store',
      });
    } catch {
      return { allow: false, reason: 'permission-denied', error: hcsError('permission_denied', `Permission denied: ${permission}`, { entry, requirement: 'HCS-0005-R012' }) };
    }
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
