/**
 * Pure decision core for the session-exit ROUTING (issue #855).
 *
 * After the exit handler in `exit-workflow.ts` has run its I/O-bound early guards
 * — the workspace was already merged out-of-band, or a provider usage limit was hit
 * (the latter has its own pure core in `rate-limit-exit-decision.ts`) — and reset
 * the workspace back to idle, it must route the exit to exactly one terminal
 * handler: skip a read-only plan run, retry a fix-and-merge, clean up a learning
 * step, surface a failed session, apply a reviewer's verdict, or move a builder's
 * committed work to review.
 *
 * That routing used to be a chain of `if (set.has(sessionId)) { … return }`
 * branches tangled with db writes, sessionManager relaunches and board broadcasts,
 * so the PRIORITY between the cases was invisible and untestable — the class of bug
 * behind several exit-path outages. In particular:
 *   - a fix-and-merge or learning session that exits NON-zero must NOT be treated as
 *     a generic "failed" session (its own handler inspects the exit code), and
 *   - a review or builder session that exits non-zero MUST be routed to "failed"
 *     (a crashed reviewer must never have its "verdict" applied).
 *
 * This function is pure (no I/O), so the full priority table is testable in ms. The
 * exit handler keeps every side effect; it only asks here for the verdict.
 */

/** The terminal route for a session exit, highest-priority first (see classifySessionExit). */
export type SessionExitAction =
  | "plan-mode-skip"
  | "fix-and-merge"
  | "learning-cleanup"
  | "failed"
  | "review"
  | "builder";

/**
 * The pure inputs the routing decision depends on. The exit handler computes these
 * once (the three role flags from its in-memory session-id sets, the exit code from
 * the agent process) before consulting `classifySessionExit`.
 */
export interface SessionExitInputs {
  /** A read-only plan run — its plan→implement continuation is handled in session.manager, so the exit workflow is skipped regardless of the session's role. */
  wasPlanMode: boolean;
  /** The exiting session is a fix-and-merge resolver run. */
  isFixAndMerge: boolean;
  /** The exiting session is a post-merge / post-review learning step. */
  isLearning: boolean;
  /** The exiting session is an auto-review run. */
  isReview: boolean;
  /** The agent process exit code (null when it could not be determined — treated as failed). */
  exitCode: number | null;
}

/**
 * Decide which terminal handler a session exit routes to. This covers the exit AFTER
 * the handler's already-merged and usage-limit early returns and after the workspace
 * has been reset to idle. Priority — earlier wins — mirrors the original control flow
 * in `runWorkflowOnExit` exactly:
 *
 *  1. plan-mode-skip   — a plan run produces no review/merge work, whatever its role.
 *  2. fix-and-merge    — a resolver run, even on a non-zero exit (its handler inspects
 *                        the exit code itself), so it is never mis-routed to "failed".
 *  3. learning-cleanup — a learning step, even on a non-zero exit — it has no workflow.
 *  4. failed           — any OTHER session with a non-zero (or unknown) exit code.
 *  5. review           — a clean-exit review session → apply the reviewer's verdict.
 *  6. builder          — a clean-exit builder session → move committed work to review.
 */
export function classifySessionExit(inputs: SessionExitInputs): { action: SessionExitAction } {
  const { wasPlanMode, isFixAndMerge, isLearning, isReview, exitCode } = inputs;
  if (wasPlanMode) return { action: "plan-mode-skip" };
  if (isFixAndMerge) return { action: "fix-and-merge" };
  if (isLearning) return { action: "learning-cleanup" };
  if (exitCode !== 0) return { action: "failed" };
  if (isReview) return { action: "review" };
  return { action: "builder" };
}

/** The non-builder session roles the exit workflow routes on. */
export type PersistedSessionRole = "review" | "fix-and-merge" | "learning";

/**
 * Map a session's PERSISTED `sessions.triggerType` to its exit-workflow role (#950).
 *
 * "fix-conflicts" maps to the fix-and-merge role because the resolve-conflicts route
 * registers those sessions in the same `fixAndMergeSessionIds` set as fix-and-merge
 * sessions — they share one terminal handler.
 *
 * Returns null for builder-like / unknown trigger types ("agent", "chat", "initial",
 * "plan-implement", "verify", "reconcile", "bisect", "skill:*", null, …) — those fall
 * through to the failed/review/builder priority in `classifySessionExit`.
 */
export function roleFromTriggerType(triggerType: string | null | undefined): PersistedSessionRole | null {
  switch (triggerType) {
    case "review":
      return "review";
    case "fix-and-merge":
    case "fix-conflicts":
      return "fix-and-merge";
    case "learning":
      return "learning";
    default:
      return null;
  }
}

/** The three role flags `classifySessionExit` routes on. */
export interface SessionRoleFlags {
  isReview: boolean;
  isFixAndMerge: boolean;
  isLearning: boolean;
}

/**
 * Resolve a session's role flags from BOTH the in-memory tracking sets (fast path,
 * populated at launch time) and the persisted `sessions.triggerType` (source of
 * truth that survives a server restart). The DB value wins when the set misses —
 * the restart case (#950): a reattached review / fix-and-merge / learning session
 * exits into empty sets and must NOT be misclassified as a builder exit (which
 * bounced the issue back to In Review and spawned another review — the
 * stranded-review / review-loop incident class).
 */
export function resolveSessionRoleFlags(
  sessionId: string,
  triggerType: string | null | undefined,
  sets: {
    reviewSessionIds: ReadonlySet<string>;
    fixAndMergeSessionIds: ReadonlySet<string>;
    learningSessionIds: ReadonlySet<string>;
  },
): SessionRoleFlags {
  const dbRole = roleFromTriggerType(triggerType);
  return {
    isReview: sets.reviewSessionIds.has(sessionId) || dbRole === "review",
    isFixAndMerge: sets.fixAndMergeSessionIds.has(sessionId) || dbRole === "fix-and-merge",
    isLearning: sets.learningSessionIds.has(sessionId) || dbRole === "learning",
  };
}
