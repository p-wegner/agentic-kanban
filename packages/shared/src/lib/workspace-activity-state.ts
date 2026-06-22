/**
 * Canonical workspace activity-state helper.
 *
 * All callers (board endpoint, CLI status, monitor capacity) must derive
 * workspace state from this single function rather than duplicating inline
 * logic.  Prior to this, each call-site had its own slightly-different set
 * of status checks which caused inconsistent counts across the board UI,
 * the CLI `status` command, and the sprint-capacity monitor.
 */

import { parseSessionStatsBlob } from "./session-stats-blob.js";

export type WorkspaceActivityState =
  | "active"          // session running
  | "fixing"          // fix-and-merge conflict-resolution session running
  | "in-review-idle"  // idle workspace in In-Review lane with committed diff (auto-merge-eligible)
  | "idle"            // workspace stopped, no notable diff or not in-review
  | "failed"          // zero-output / <=1s / launchFailure session exit
  | "blocked"         // automation paused; human/provider recovery required
  | "merged"          // workspace.mergedAt is set (closed + merged)
  | "closed";         // closed without merge

export interface WorkspaceActivityResult {
  state: WorkspaceActivityState;
  /** True when this workspace should count against the active-agent capacity target */
  countsAsActiveCapacity: boolean;
}

/** Minimal workspace shape required by deriveWorkspaceActivityState */
export interface WorkspaceActivityInput {
  status: string;
  mergedAt?: string | null;
  /** Cached diff stats — used to distinguish in-review-idle from plain idle */
  diffStatCacheFilesChanged?: number | null;
  diffStatCacheInsertions?: number | null;
  diffStatCacheDeletions?: number | null;
}

/** Minimal session shape required by deriveWorkspaceActivityState */
export interface SessionActivityInput {
  status: string; // "running" | "stopped"
  startedAt: string;
  endedAt: string | null;
  stats: string | null;
}

/**
 * Returns true when the latest session looks like a zero-output launch failure:
 *   - ended in <=1 000 ms, OR
 *   - had zero input+output tokens, OR
 *   - carries an explicit launchFailure flag.
 */
export function isFailedLaunchSession(session: SessionActivityInput): boolean {
  if (!session.endedAt) return false;
  const durationMs = new Date(session.endedAt).getTime() - new Date(session.startedAt).getTime();
  if (durationMs <= 1000) return true;
  const s = parseSessionStatsBlob(session.stats);
  if (s) {
    if (
      (s.inputTokens === 0 || s.inputTokens == null) &&
      (s.outputTokens === 0 || s.outputTokens == null)
    ) {
      return true;
    }
    if (s.launchFailure === true) return true;
  }
  return false;
}

function hasCachedDiff(ws: WorkspaceActivityInput): boolean {
  return (
    (ws.diffStatCacheFilesChanged ?? 0) > 0 ||
    (ws.diffStatCacheInsertions ?? 0) > 0 ||
    (ws.diffStatCacheDeletions ?? 0) > 0
  );
}

/**
 * Derive the canonical activity state for a workspace + its latest session.
 *
 * @param workspace  Workspace row (or compatible minimal shape)
 * @param latestSession  The most-recent session for this workspace, or null
 * @param effectiveStatusName  The effective issue status name (e.g. "In Review"),
 *   used to detect auto-merge-eligible in-review-idle workspaces.  Pass null if unknown.
 */
export function deriveWorkspaceActivityState(
  workspace: WorkspaceActivityInput,
  latestSession: SessionActivityInput | null,
  effectiveStatusName: string | null = null,
): WorkspaceActivityResult {
  const wsStatus = workspace.status;

  // Closed workspaces — distinguish merged from abandoned
  if (wsStatus === "closed") {
    if (workspace.mergedAt) {
      return { state: "merged", countsAsActiveCapacity: false };
    }
    return { state: "closed", countsAsActiveCapacity: false };
  }

  // Active running session
  if (wsStatus === "active") {
    return { state: "active", countsAsActiveCapacity: true };
  }

  // Fix-and-merge conflict resolution (counts as active capacity per board learnings)
  if (wsStatus === "fixing") {
    return { state: "fixing", countsAsActiveCapacity: true };
  }

  if (wsStatus === "blocked") {
    return { state: "blocked", countsAsActiveCapacity: false };
  }

  // Review or awaiting-plan-approval — session is running
  if (wsStatus === "reviewing" || wsStatus === "awaiting-plan-approval") {
    return { state: "active", countsAsActiveCapacity: true };
  }

  // Idle workspace — check for failed launch, then in-review-idle, then plain idle
  if (wsStatus === "idle" || wsStatus === "error") {
    // Failed launch: session ended too quickly with no output
    if (latestSession && latestSession.status === "stopped" && isFailedLaunchSession(latestSession)) {
      return { state: "failed", countsAsActiveCapacity: false };
    }

    // In-review-idle: workspace stopped in the "In Review" lane with committed changes
    // → auto-merge-eligible; not counted as "idle awaiting work"
    if (
      effectiveStatusName === "In Review" &&
      hasCachedDiff(workspace)
    ) {
      return { state: "in-review-idle", countsAsActiveCapacity: false };
    }

    return { state: "idle", countsAsActiveCapacity: false };
  }

  // Fallback (unexpected status)
  return { state: "idle", countsAsActiveCapacity: false };
}

/**
 * Status priority for picking the "main" workspace per issue.
 * Lower number = higher priority (most-active wins).
 */
export function workspaceStatusPriority(status: string): number {
  switch (status) {
    case "active": return 0;
    case "fixing": return 1;
    case "reviewing": return 2;
    case "awaiting-plan-approval": return 3;
    case "blocked": return 4;
    case "idle": return 4;
    default: return 5; // closed, error, unknown
  }
}

/** The set of workspace statuses that represent an active/running agent */
export const ACTIVE_WORKSPACE_STATUSES = new Set<string>([
  "active",
  "fixing",
  "reviewing",
  "awaiting-plan-approval",
]);

/**
 * Returns true when an issue's workspaceSummary indicates in-flight work
 * (active, fixing, or in-review session). Used by the operator focus filter.
 */
export function isIssueInFlight(workspaceSummary: {
  main?: { status?: string } | null;
} | null | undefined): boolean {
  const mainStatus = workspaceSummary?.main?.status;
  if (!mainStatus) return false;
  return ACTIVE_WORKSPACE_STATUSES.has(mainStatus) || mainStatus === "in-review-idle";
}
