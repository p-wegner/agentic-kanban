/**
 * `GET /api/projects/:id/tracker-snapshot` — the wire contract (#1140).
 *
 * A compact, poll-friendly board summary for a terminal tracker: everything one such UI
 * needs in a single small payload, reusing the same resolvers/queries the board itself
 * uses (WIP resolution, monitor tunables, workspace/session state) rather than re-deriving
 * them. Kept intentionally small and flat so it is cheap to poll every few seconds.
 */

import type { ImpactMissRateSummary } from "./monitor.js";

/** Per-column ticket count, in the project's own column order. */
export interface TrackerSnapshotColumn {
  statusId: string;
  name: string;
  count: number;
}

export type TrackerAgentState = "active" | "fixing" | "reviewing" | "blocked" | "idle" | "error";

/** One in-flight workspace — a ticket currently being worked. */
export interface TrackerSnapshotInFlight {
  workspaceId: string;
  issueId: string;
  issueNumber: number | null;
  title: string;
  statusName: string;
  agentState: TrackerAgentState;
  /** ms since the workspace was created. */
  ageMs: number;
  /** ms since the latest session's last recorded activity (started/ended), or null if no session ever ran. */
  lastOutputAgeMs: number | null;
}

/** A workspace that is blocked or appears stalled, with a human-readable reason. */
export interface TrackerSnapshotBlocked {
  workspaceId: string;
  issueId: string;
  issueNumber: number | null;
  title: string;
  reason: string;
}

export interface TrackerSnapshotBaseBranchHealth {
  outcome: string | null;
  sha: string | null;
  checkedAt: string | null;
  /**
   * What the sweep's `tests` step reported it RAN (#1231): `full`, `file-scoped`,
   * `impact-selected`, ... `null` when the verify script reported no scope (or the row predates
   * the column). Optional on the wire for an older server.
   */
  scope?: string | null;
}

export interface TrackerSnapshotResponse {
  projectId: string;
  generatedAt: string;
  columns: TrackerSnapshotColumn[];
  wipLimit: number;
  activeBuilderCount: number;
  inFlight: TrackerSnapshotInFlight[];
  blocked: TrackerSnapshotBlocked[];
  /** Number of workspaces currently in a review/merge-pending state. */
  reviewQueueDepth: number;
  baseBranchHealth: TrackerSnapshotBaseBranchHealth | null;
  /**
   * The impact-tier miss rate over the project's test-impact corpus (#1234), `null` when the
   * project has no outcomes ledger. Optional on the wire for an older server.
   */
  impactMissRate?: ImpactMissRateSummary | null;
}
