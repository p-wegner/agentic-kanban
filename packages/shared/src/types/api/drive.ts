// Drive-dashboard wire-contract types (pure DTOs). See ../api.ts barrel.

/**
 * Aggregated, at-a-glance view of a running drive (#800).
 *
 * Scope is the drive's meta/epic issue and its direct children (the `parent_of`
 * edges seeded for a drive epic). All fields are computed server-side from the
 * board + dependency graph + board-health-event log — no live build is run, so
 * the endpoint is cheap enough to poll alongside the board.
 */
export interface DriveDashboardIssue {
  id: string;
  issueNumber: number | null;
  title: string;
  statusName: string;
  /** 0-based dependency depth among the drive's issues (tier graph row). */
  tier: number;
}

export interface DriveDashboardStall {
  id: string;
  issueNumber: number | null;
  title: string;
  statusName: string;
  /** Open upstream issues that are holding this one back. */
  blockedBy: Array<{ issueNumber: number | null; title: string }>;
}

export interface DriveDashboard {
  drive: {
    id: string;
    projectId: string;
    metaIssueId: string | null;
    target: string;
    completionContract: string | null;
    status: "active" | "completed" | "abandoned";
    startedAt: string;
    finishedAt: string | null;
  };
  /** N/N progress over the drive's scoped issues (meta excluded). */
  progress: {
    total: number;
    done: number;
    inProgress: number;
    inReview: number;
    todo: number;
    /** Issues whose status the wave-planner treats as terminal (done/cancelled). */
    percentDone: number;
  };
  /** Dependency tiers (tier 0 = no open blockers within the drive), ascending. */
  tiers: Array<{
    tier: number;
    issues: DriveDashboardIssue[];
  }>;
  /** Issues currently blocked by open upstream work — the obstacle list. */
  stalls: DriveDashboardStall[];
  /**
   * The most recent merge-category board-health event for the project — a proxy
   * for "last cascade event" (a merge is what unblocks downstream tiers). Null
   * when none has been recorded.
   */
  lastCascade: {
    summary: string;
    issueNumber: number | null;
    createdAt: string;
  } | null;
  /**
   * Cold-build-clean status. The cold-clone gate is expensive (a full fresh
   * clone + build), so this reports the gate's ENABLEMENT and the latest
   * build-related health event rather than running it live.
   */
  buildClean: {
    /** Whether the per-project cold-clone build gate is switched on. */
    coldCloneGateEnabled: boolean;
    /** Whether a verify gate (the keystone merge gate) is configured. */
    verifyGateConfigured: boolean;
    /** Latest server/launch/error health event mentioning a build/verify failure, if any. */
    lastBuildEvent: {
      summary: string;
      issueNumber: number | null;
      createdAt: string;
      eventType: string;
    } | null;
  };
}
