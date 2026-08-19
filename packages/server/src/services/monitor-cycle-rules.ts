import { parseSessionStatsBlob } from "@agentic-kanban/shared";
import { isBuilderCycleTrigger } from "@agentic-kanban/shared/lib/session-trigger";
import { isClaudeUsageLimitStats } from "./claude-rate-limit.js";
import { isCodexUsageLimitStats } from "./codex-rate-limit.js";
import type { WorkspaceCandidate } from "../startup/monitor-cycle.js";

export const MAX_SESSIONS = 10;
export const DEFAULT_STUCK_BUILDER_TIMEOUT_MS = 9 * 60 * 1000;
export const NON_TRIVIAL_WORKTREE_DIFF_CHARS = 80;
const REPEATED_FAILED_COMMAND_MIN_COUNT = 3;
/**
 * How long a quota block is honoured when the provider gave us no usable reset time
 * (`retryAfter` absent or unparseable). Without this the "no reset time" case is a
 * PERMANENT block, which is the whole of #387 — so the choice is between re-probing
 * too early and never re-probing at all. Re-probing too early costs one launch that
 * immediately re-blocks with a FRESH `retryAfter` (or a fresh `startedAt`, restarting
 * this window from now), so the error is self-correcting and bounded to one probe per
 * window per workspace. Never re-probing costs the workspace forever.
 */
export const QUOTA_BLOCK_PROBE_FALLBACK_MS = 6 * 60 * 60 * 1000;

export type LatestSession = {
  id: string;
  status: string;
  startedAt: string;
  triggerType: string | null;
  stats: string | null;
};

export function parseStuckBuilderTimeoutMs(): number {
  const fromEnv = Number(process.env.STUCK_BUILDER_TIMEOUT_MS);
  return Number.isFinite(fromEnv) && fromEnv > 0 ? fromEnv : DEFAULT_STUCK_BUILDER_TIMEOUT_MS;
}

export function parseSessionStats(stats: string | null): Record<string, unknown> {
  return parseSessionStatsBlob(stats) ?? {};
}

export function hasRepeatedFailedCommand(stats: string | null): boolean {
  const parsed = parseSessionStats(stats);
  const friction = parsed.friction && typeof parsed.friction === "object"
    ? parsed.friction as Record<string, unknown>
    : null;
  if (!friction) return false;
  const failedToolCalls = Number(friction.failedToolCalls ?? 0);
  const errorCount = Number(friction.errorCount ?? 0);
  const repeatedCommands = Array.isArray(friction.repeatedCommands) ? friction.repeatedCommands : [];
  return (failedToolCalls >= 2 || errorCount >= 2)
    && repeatedCommands.some((cmd) =>
      cmd
      && typeof cmd === "object"
      && Number((cmd as Record<string, unknown>).count ?? 0) >= REPEATED_FAILED_COMMAND_MIN_COUNT,
    );
}

/**
 * Is this the ticket's implementer, as the monitor cycle counts it? Delegates to the
 * shared traits table's `builderCycle` flag (#495), which is deliberately NOT the same
 * predicate the launcher uses: `auto-start` and `skill:*` runs continue the worktree but
 * are started by the monitor itself, so counting them here would make the cycle wait on
 * its own work.
 */
export function isBuilderSession(sess: LatestSession): boolean {
  return isBuilderCycleTrigger(sess.triggerType);
}

/** A `blocked` workspace parked there by a provider usage limit, and whether its wait is over. */
export type QuotaBlock = {
  /** The provider's own reset time, when it gave a parseable one. */
  retryAfter: string | null;
  /** The moment this block stops being honoured — `retryAfter`, else `startedAt + fallback`. */
  releaseAt: string;
  /** True once `releaseAt` has passed, i.e. the workspace may return to automation. */
  expired: boolean;
};

/**
 * Classify a `blocked` workspace's latest session as a quota block, and decide whether the
 * wait has elapsed.
 *
 * Reads the reset time out of the SAME session-stats blob the monitor cycle already loads
 * for every candidate, so no new column and no new write path are needed — and, unlike a
 * newly-persisted deadline, this recognises the workspaces that are ALREADY wedged.
 *
 * Returns `null` when the session is not a usage-limit death, so a workspace blocked for
 * any other reason keeps needing a human (which is what `blocked` is for).
 */
export function classifyQuotaBlock(
  sess: { startedAt?: string | null; stats: string | null } | null | undefined,
  nowMs: number,
): QuotaBlock | null {
  const stats = sess?.stats ?? null;
  if (!isClaudeUsageLimitStats(stats) && !isCodexUsageLimitStats(stats)) return null;
  const parsed = parseSessionStats(stats);
  const rawRetryAfter = typeof parsed.retryAfter === "string" ? parsed.retryAfter : null;
  const retryAfterMs = rawRetryAfter ? Date.parse(rawRetryAfter) : Number.NaN;
  if (Number.isFinite(retryAfterMs)) {
    return {
      retryAfter: rawRetryAfter,
      releaseAt: new Date(retryAfterMs).toISOString(),
      expired: nowMs >= retryAfterMs,
    };
  }
  // No usable reset time — fall back to a bounded probe window measured from the death.
  const startedMs = sess?.startedAt ? Date.parse(sess.startedAt) : Number.NaN;
  const anchorMs = Number.isFinite(startedMs) ? startedMs : nowMs;
  const releaseMs = anchorMs + QUOTA_BLOCK_PROBE_FALLBACK_MS;
  return {
    retryAfter: rawRetryAfter,
    releaseAt: new Date(releaseMs).toISOString(),
    expired: nowMs >= releaseMs,
  };
}

/**
 * Order a project's candidates so the ones whose decision costs NOTHING go first.
 *
 * The per-project time budget cuts the walk off wherever it happens to be, and a
 * `blocked` candidate's decision is a stats parse plus at most one DB write — no git, no
 * subprocess. Leaving it at the back means the quota-release transition (#387) is starved
 * by the expensive idle/merge candidates AHEAD of it and may never be reached at all:
 * measured on `eventhub`, the walk deferred 6-21 remaining candidates EVERY cycle (one
 * candidate even burned the 5-minute per-candidate timeout on a hung git call), so two
 * releasable workspaces sat blocked across several cycles purely because of their position.
 *
 * Stable within each group, so the previous relative order is otherwise unchanged.
 */
export function orderCandidatesForWalk<T extends { wsStatus: string }>(candidates: T[]): T[] {
  const cheap: T[] = [];
  const rest: T[] = [];
  for (const candidate of candidates) (candidate.wsStatus === "blocked" ? cheap : rest).push(candidate);
  return cheap.length === 0 ? candidates : [...cheap, ...rest];
}

export function isZeroDiffInReviewAwaiting(ws: WorkspaceCandidate): boolean {
  return ws.issueStatusName === "In Review"
    && !ws.isDirect
    && !!ws.workingDir
    && !ws.readyForMerge
    && ws.diffStatCacheFilesChanged === 0
    && (ws.diffStatCacheInsertions ?? 0) === 0
    && (ws.diffStatCacheDeletions ?? 0) === 0;
}
