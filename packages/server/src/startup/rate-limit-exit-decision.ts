/**
 * Pure decision core for the session-exit rate-limit path.
 *
 * The Codex and Claude rate-limit branches in `exit-workflow.ts` each made the
 * same two decisions inline (is this a builder session? relaunch or leave
 * blocked, and with what reason). That logic sat behind db reads, sessionManager
 * relaunches, and board broadcasts, so it was untestable and the two copies could
 * drift — exactly the class of bug behind the #696–699 / #779 rotation outages.
 *
 * These functions are pure (no I/O), so the decision is table-testable in ms.
 * The exit handler keeps the side effects; it just asks these for the verdict.
 */

/** Session-id sets that distinguish a builder run from special (non-builder) sessions. */
export interface SpecialSessionSets {
  reviewSessionIds: ReadonlySet<string>;
  fixAndMergeSessionIds: ReadonlySet<string>;
  learningSessionIds: ReadonlySet<string>;
}

/**
 * A session is a "builder" (worktree-continuing) run unless it is a review,
 * fix-and-merge, or learning session. Only builder sessions are relaunched on a
 * fresh profile after a rate-limit rotation; the others inherit the switched pref
 * and rely on their own reconciler.
 */
export function isBuilderSession(sessionId: string, sets: SpecialSessionSets): boolean {
  return (
    !sets.reviewSessionIds.has(sessionId) &&
    !sets.fixAndMergeSessionIds.has(sessionId) &&
    !sets.learningSessionIds.has(sessionId)
  );
}

/** Minimal structural view of a profile-ring rotation result (decoupled from either ring). */
export interface RotationOutcome {
  rotated: boolean;
  toProfile?: string;
  reason: string;
}

export type RateLimitProvider = "Codex" | "Claude";

/** The settings pref key each provider's active profile lives under. */
const PROFILE_PREF_KEY: Record<RateLimitProvider, string> = {
  Codex: "codex_profile",
  Claude: "claude_profile",
};

/**
 * Decide what to do with a rate-limited session's workspace.
 *  - "relaunch": the ring rotated to a fresh profile AND this is a builder session
 *                → relaunch the worktree on the new profile.
 *  - "block":    otherwise → leave the workspace blocked for a manual relaunch.
 */
export function decideRateLimitExit(
  rotation: RotationOutcome,
  builder: boolean,
): { action: "relaunch" | "block" } {
  if (rotation.rotated && rotation.toProfile && builder) return { action: "relaunch" };
  return { action: "block" };
}

/** Human-readable reason stamped on a workspace left blocked after a rate limit. */
export function formatRateLimitBlockedReason(
  provider: RateLimitProvider,
  workspaceId: string,
  rotation: RotationOutcome,
): string {
  if (rotation.rotated) {
    return `${provider} usage limit reached for workspace ${workspaceId}; rotated ${PROFILE_PREF_KEY[provider]} to '${rotation.toProfile}' (relaunch a builder manually).`;
  }
  return `${provider} usage limit reached for workspace ${workspaceId}; ${rotation.reason}. Monitor will not relaunch it automatically.`;
}
