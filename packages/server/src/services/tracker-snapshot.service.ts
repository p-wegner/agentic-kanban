import type { Database } from "../db/index.js";
import { db } from "../db/index.js";
import type { TrackerSnapshotResponse, TrackerAgentState } from "@agentic-kanban/shared";
import { occupiesWipSlot } from "@agentic-kanban/shared/lib/workspace-liveness";
import { toPrefMap } from "@agentic-kanban/shared/lib/preference-map";
import { getAllPreferencesCached } from "../repositories/preferences.repository.js";
import { resolveWipLimit } from "./wip-limit.service.js";
import { getLatestBaseBranchHealth } from "../repositories/base-branch-health.repository.js";
import {
  getTrackerColumnCounts,
  listTrackerWorkspaceRows,
  getReviewQueueDepth,
} from "../repositories/tracker-snapshot.repository.js";

function agentStateFor(status: string): TrackerAgentState {
  switch (status) {
    case "active": return "active";
    case "fixing": return "fixing";
    case "reviewing": return "reviewing";
    case "blocked": return "blocked";
    case "error": return "error";
    default: return "idle";
  }
}

/** A human-readable reason a workspace is blocked/stalled, or null when it isn't. */
function blockedReasonFor(row: {
  workspaceStatus: string;
  readyForMerge: boolean;
  latestSession: { status: string; startedAt: string; endedAt: string | null } | null;
}, nowMs: number): string | null {
  if (row.workspaceStatus === "blocked") return "workspace is blocked — automation paused, needs recovery";
  if (row.workspaceStatus === "error") return "workspace's latest session ended in error";
  if (row.workspaceStatus === "idle" && row.latestSession?.status === "running") {
    // A running session on an idle-recorded workspace is itself a stall signal.
    return "session recorded running but workspace is idle";
  }
  // An idle workspace ready to merge is queued, not stalled — reviewQueueDepth already covers it.
  if (row.workspaceStatus === "idle" && !row.readyForMerge && !row.latestSession) return "idle with no session ever run";
  return null;
}

function ageMsFrom(iso: string, nowMs: number): number {
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? Math.max(0, nowMs - ms) : 0;
}

export async function buildTrackerSnapshot(
  projectId: string,
  database: Database = db,
  // Pure arithmetic (ages/TTLs only, nothing persisted), so the sanctioned spelling is
  // `nowMs?: number` rather than `now?: string` (#614 convention, #1213).
  nowMs: number = Date.now(),
): Promise<TrackerSnapshotResponse> {

  const [columns, workspaceRows, reviewQueueDepth, latestBaseHealth, prefRows] = await Promise.all([
    getTrackerColumnCounts(projectId, database),
    listTrackerWorkspaceRows(projectId, database),
    getReviewQueueDepth(projectId, database),
    getLatestBaseBranchHealth(projectId, database),
    getAllPreferencesCached(database).catch(() => []),
  ]);

  const prefMap = toPrefMap(prefRows);
  const { limit: wipLimit } = resolveWipLimit(prefMap, projectId);

  const activeBuilderCount = workspaceRows.filter((row) => occupiesWipSlot(row.workspaceStatus)).length;

  const inFlight = workspaceRows
    .filter((row) => occupiesWipSlot(row.workspaceStatus))
    .map((row) => ({
      workspaceId: row.workspaceId,
      issueId: row.issueId,
      issueNumber: row.issueNumber,
      title: row.title,
      statusName: row.statusName,
      agentState: agentStateFor(row.workspaceStatus),
      ageMs: ageMsFrom(row.createdAt, nowMs),
      lastOutputAgeMs: row.latestSession
        ? ageMsFrom(row.latestSession.endedAt ?? row.latestSession.startedAt, nowMs)
        : null,
    }));

  const blocked = workspaceRows
    .map((row) => ({ row, reason: blockedReasonFor(row, nowMs) }))
    .filter((x): x is { row: typeof workspaceRows[number]; reason: string } => x.reason !== null)
    .map(({ row, reason }) => ({
      workspaceId: row.workspaceId,
      issueId: row.issueId,
      issueNumber: row.issueNumber,
      title: row.title,
      reason,
    }));

  return {
    projectId,
    generatedAt: new Date(nowMs).toISOString(),
    columns,
    wipLimit,
    activeBuilderCount,
    inFlight,
    blocked,
    reviewQueueDepth,
    baseBranchHealth: latestBaseHealth
      ? {
          outcome: latestBaseHealth.outcome,
          sha: latestBaseHealth.sha,
          checkedAt: latestBaseHealth.createdAt,
          // #1231 — what the sweep RAN; a `green` at `file-scoped` is not a full-suite green.
          scope: latestBaseHealth.scope ?? null,
        }
      : null,
  };
}
