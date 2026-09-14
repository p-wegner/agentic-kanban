import { workspaces, issues, projectStatuses, sessions } from "@agentic-kanban/shared/schema";
import { eq, and, desc, inArray } from "drizzle-orm";
import { db } from "../db/index.js";
import type { Database } from "../db/index.js";
import { TERMINAL_WORKSPACE_STATUSES } from "@agentic-kanban/shared/lib/workspace-liveness";

/** Per-status ticket counts for a project, in column order (#1140). */
export async function getTrackerColumnCounts(
  projectId: string,
  database: Database = db,
) {
  const statuses = await database
    .select({ id: projectStatuses.id, name: projectStatuses.name })
    .from(projectStatuses)
    .where(eq(projectStatuses.projectId, projectId))
    .orderBy(projectStatuses.sortOrder);

  const issueRows = await database
    .select({ statusId: issues.statusId })
    .from(issues)
    .where(eq(issues.projectId, projectId));

  const countByStatus = new Map<string, number>();
  for (const row of issueRows) {
    countByStatus.set(row.statusId, (countByStatus.get(row.statusId) ?? 0) + 1);
  }

  return statuses.map((s) => ({ statusId: s.id, name: s.name, count: countByStatus.get(s.id) ?? 0 }));
}

/**
 * Non-terminal workspaces for a project, each with its issue title/number/status and its
 * latest session's status/timestamps — one query per concern, no per-workspace fan-out.
 * This is what the tracker snapshot's in-flight/blocked sections are built from.
 */
export async function listTrackerWorkspaceRows(
  projectId: string,
  database: Database = db,
) {
  const rows = await database
    .select({
      workspaceId: workspaces.id,
      issueId: workspaces.issueId,
      issueNumber: issues.issueNumber,
      title: issues.title,
      statusName: projectStatuses.name,
      workspaceStatus: workspaces.status,
      readyForMerge: workspaces.readyForMerge,
      createdAt: workspaces.createdAt,
      updatedAt: workspaces.updatedAt,
    })
    .from(workspaces)
    .innerJoin(issues, eq(workspaces.issueId, issues.id))
    .innerJoin(projectStatuses, eq(issues.statusId, projectStatuses.id))
    .where(and(
      eq(issues.projectId, projectId),
      inArray(
        workspaces.status,
        // notInArray reads more naturally here, but the workspace-liveness module only
        // exports the terminal set — inverted below, in TS, keeps one source of truth.
        // Must list EVERY non-terminal WorkspaceStatus (incl. ready_for_merge, #1140 bug:
        // that status was omitted, so a workspace ready to merge vanished from the
        // snapshot entirely instead of showing in the review/merge queue).
        ["active", "idle", "blocked", "reviewing", "fixing", "awaiting-plan-approval", "error", "ready_for_merge"]
          .filter((s) => !(TERMINAL_WORKSPACE_STATUSES as readonly string[]).includes(s)),
      ),
    ));

  const workspaceIds = rows.map((r) => r.workspaceId);
  const latestSessionByWorkspace = await getLatestSessionByWorkspace(workspaceIds, database);

  return rows.map((row) => ({
    ...row,
    latestSession: latestSessionByWorkspace.get(row.workspaceId) ?? null,
  }));
}

async function getLatestSessionByWorkspace(
  workspaceIds: string[],
  database: Database,
): Promise<Map<string, { status: string; startedAt: string; endedAt: string | null }>> {
  const result = new Map<string, { status: string; startedAt: string; endedAt: string | null }>();
  if (workspaceIds.length === 0) return result;

  const rows = await database
    .select({
      workspaceId: sessions.workspaceId,
      status: sessions.status,
      startedAt: sessions.startedAt,
      endedAt: sessions.endedAt,
    })
    .from(sessions)
    .where(inArray(sessions.workspaceId, workspaceIds))
    .orderBy(desc(sessions.startedAt));

  // Rows arrive newest-first per the ORDER BY; keep only the first sighting per workspace.
  for (const row of rows) {
    if (!result.has(row.workspaceId)) {
      result.set(row.workspaceId, { status: row.status, startedAt: row.startedAt, endedAt: row.endedAt });
    }
  }
  return result;
}

/** Count of workspaces in review-ish states or flagged ready to merge, for a project (#1140). */
export async function getReviewQueueDepth(
  projectId: string,
  database: Database = db,
): Promise<number> {
  const rows = await database
    .select({ id: workspaces.id, status: workspaces.status, readyForMerge: workspaces.readyForMerge })
    .from(workspaces)
    .innerJoin(issues, eq(workspaces.issueId, issues.id))
    .where(eq(issues.projectId, projectId));

  return rows.filter((r) => r.status === "reviewing" || r.readyForMerge).length;
}
