import { projectStatuses, issues, workspaces, sessions, preferences, workflowNodes } from "@agentic-kanban/shared/schema";
import { eq, inArray } from "drizzle-orm";
import { db } from "../db/index.js";
import type { Database } from "../db/index.js";
import { getProjectById } from "./project.repository.js";

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
    .select({ key: preferences.key, value: preferences.value })
    .from(preferences)
    .where(inArray(preferences.key, ["auto_merge", "auto_merge_in_review"]));
}

/** Project statuses (id/name), ordered by sortOrder. */
export async function getBoardStatusStatuses(
  projectId: string,
  database: Database = db,
) {
  return database
    .select({ id: projectStatuses.id, name: projectStatuses.name })
    .from(projectStatuses)
    .where(eq(projectStatuses.projectId, projectId))
    .orderBy(projectStatuses.sortOrder);
}

/** Issues with status names + current workflow node type (LEFT JOIN for non-workflow issues). */
export async function getBoardStatusIssues(
  projectId: string,
  database: Database = db,
) {
  return database
    .select({
      id: issues.id,
      issueNumber: issues.issueNumber,
      title: issues.title,
      priority: issues.priority,
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

/** All workspaces belonging to the given issues. */
export async function getWorkspacesForIssues(
  issueIds: string[],
  database: Database = db,
) {
  return database.select().from(workspaces).where(inArray(workspaces.issueId, issueIds));
}

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

/** Sessions for the given workspace ids. */
export async function getSessionsForWorkspaces(
  wsIds: string[],
  database: Database = db,
) {
  if (wsIds.length === 0) return [];
  return database.select().from(sessions).where(inArray(sessions.workspaceId, wsIds));
}
