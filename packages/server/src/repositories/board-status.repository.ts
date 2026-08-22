import { projectStatuses, issues, workspaces, sessions, preferences, workflowNodes } from "@agentic-kanban/shared/schema";
import { eq, inArray } from "drizzle-orm";
import { db } from "../db/index.js";
import type { Database } from "../db/index.js";
import { getProjectById } from "./project.repository.js";
import { issueTriageColumns, preferenceKeyValueColumns, projectStatusIdName, sessionLifecycleColumns } from "./projections.js";
import { listProjectStatusIdNames } from "./project-status.repository.js";

/** Resolve the active project id from the `activeProjectId` preference. */
export async function getActiveProjectIdPref(
  database: Database = db,
): Promise<string | null> {
  const pref = await database
    .select({ value: preferences.value })
    .from(preferences)
    .where(eq(preferences.key, "activeProjectId"))
    .limit(1);
  return pref.length === 0 ? null : pref[0].value;
}

/** Project header row (id/name/repoPath/defaultBranch). */
export async function getBoardStatusProject(
  projectId: string,
  database: Database = db,
) {
  const project = await getProjectById(projectId, database);
  return project ? { id: project.id, name: project.name, repoPath: project.repoPath, defaultBranch: project.defaultBranch } : null;
}

/** Auto-merge preference key/value pairs relevant to board-status classification. */
export async function getAutoMergePreferences(
  database: Database = db,
) {
  return database
    .select(preferenceKeyValueColumns)
    .from(preferences)
    .where(inArray(preferences.key, ["auto_merge", "auto_merge_in_review"]));
}

/**
 * Project statuses (id/name), ordered by sortOrder.
 *
 * ORDER-DEPENDENT (#773): these are the board's columns as a human reads them, left to
 * right. `listProjectStatusIdNames` orders unconditionally, so the `{ ordered: true }`
 * this used to pass is gone rather than moved.
 */
export async function getBoardStatusStatuses(
  projectId: string,
  database: Database = db,
) {
  return listProjectStatusIdNames(projectId, database);
}

/** Issues with status names + current workflow node type (LEFT JOIN for non-workflow issues). */
export async function getBoardStatusIssues(
  projectId: string,
  database: Database = db,
) {
  return database
    .select({
      ...issueTriageColumns,
      issueType: issues.issueType,
      statusId: issues.statusId,
      statusName: projectStatuses.name,
      currentNodeType: workflowNodes.nodeType,
    })
    .from(issues)
    .innerJoin(projectStatuses, eq(issues.statusId, projectStatuses.id))
    .leftJoin(workflowNodes, eq(issues.currentNodeId, workflowNodes.id))
    .where(eq(issues.projectId, projectId));
}

/**
 * All workspaces belonging to the given issues — slim projection (#418 G17).
 * `workspaces` is the widest table in the schema (conflict_cache_files,
 * code_metrics_json, prompt/plan columns), and this feeds `get_board_status`,
 * called by every agent and the monitor; a bare SELECT * dragged all of that
 * through the driver per call. Only the columns the board-status assembly
 * actually reads are selected: grouping/selection (id, issueId, status,
 * updatedAt, currentNodeId), the wire entry (branch, workingDir, baseBranch,
 * isDirect, readyForMerge) — which also covers diff-stats + conflict
 * enrichment. Widen deliberately if board-status grows a new consumer.
 */
export async function getWorkspacesForIssues(
  issueIds: string[],
  database: Database = db,
) {
  return database
    .select({
      id: workspaces.id,
      issueId: workspaces.issueId,
      branch: workspaces.branch,
      status: workspaces.status,
      workingDir: workspaces.workingDir,
      baseBranch: workspaces.baseBranch,
      isDirect: workspaces.isDirect,
      readyForMerge: workspaces.readyForMerge,
      currentNodeId: workspaces.currentNodeId,
      updatedAt: workspaces.updatedAt,
    })
    .from(workspaces)
    .where(inArray(workspaces.issueId, issueIds));
}

/** Slim board-status workspace row (see getWorkspacesForIssues). */
export type BoardStatusWorkspaceRow = Awaited<ReturnType<typeof getWorkspacesForIssues>>[number];

/** Workflow node status-name mapping for the given node ids. */
export async function getWorkflowNodeStatuses(
  currentNodeIds: string[],
  database: Database = db,
) {
  if (currentNodeIds.length === 0) return [];
  return database
    .select({ id: workflowNodes.id, statusName: workflowNodes.statusName })
    .from(workflowNodes)
    .where(inArray(workflowNodes.id, currentNodeIds));
}

/**
 * Sessions for the given workspace ids — slim projection (#418 G17). The
 * board-status assembly reads only grouping/sorting fields (workspaceId,
 * startedAt), noise filtering (triggerType), the wire entry (id, status,
 * endedAt) and the stats blob it parses; SELECT * additionally hauled pid,
 * claudeSessionId, context and error columns nobody consumed.
 */
export async function getSessionsForWorkspaces(
  wsIds: string[],
  database: Database = db,
) {
  if (wsIds.length === 0) return [];
  return database
    .select({
      ...sessionLifecycleColumns,
      stats: sessions.stats,
      triggerType: sessions.triggerType,
    })
    .from(sessions)
    .where(inArray(sessions.workspaceId, wsIds));
}
