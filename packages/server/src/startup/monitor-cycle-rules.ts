import { parseSessionStatsBlob } from "@agentic-kanban/shared";
import type { WorkspaceCandidate } from "./monitor-cycle.js";

export const MAX_SESSIONS = 10;
export const DEFAULT_STUCK_BUILDER_TIMEOUT_MS = 9 * 60 * 1000;
export const NON_TRIVIAL_WORKTREE_DIFF_CHARS = 80;
const REPEATED_FAILED_COMMAND_MIN_COUNT = 3;

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

export function isBuilderSession(sess: LatestSession): boolean {
  return !sess.triggerType || sess.triggerType === "agent" || sess.triggerType === "chat" || sess.triggerType === "plan-implement";
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
