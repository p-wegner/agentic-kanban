import { projects, projectStatuses, issues, workspaces, preferences } from "@agentic-kanban/shared/schema";
import { ACTIVE_WORKSPACE_STATUSES } from "@agentic-kanban/shared/lib/workspace-activity-state";
import { eq, and, inArray, notInArray, sql } from "drizzle-orm";
import { db } from "../db/index.js";
import type { Database, TransactionClient } from "../db/index.js";

export async function getProjectsBasePath(database: Database = db) {
  const rows = await database
    .select({ value: preferences.value })
    .from(preferences)
    .where(eq(preferences.key, "projects_base_path"))
    .limit(1);
  return rows;
}

export async function updateProjectFields(
  id: string,
  updates: Record<string, unknown>,
  database: Database | TransactionClient = db,
): Promise<void> {
  await database.update(projects).set(updates).where(eq(projects.id, id));
}

export async function clearActiveProjectPreference(
  projectId: string,
  database: Database = db,
): Promise<void> {
  await database
    .delete(preferences)
    .where(and(eq(preferences.key, "activeProjectId"), eq(preferences.value, projectId)));
}

export async function getProjectWorkspacesWithIssue(
  projectId: string,
  database: Database = db,
) {
  return database
    .select({
      id: workspaces.id,
      issueId: workspaces.issueId,
      branch: workspaces.branch,
      workingDir: workspaces.workingDir,
      baseBranch: workspaces.baseBranch,
      isDirect: workspaces.isDirect,
      status: workspaces.status,
      issueNumber: issues.issueNumber,
      issueTitle: issues.title,
    })
    .from(workspaces)
    .innerJoin(issues, eq(workspaces.issueId, issues.id))
    .where(eq(issues.projectId, projectId));
}

export async function getWorkspaceWorkingDirById(
  workspaceId: string,
  database: Database = db,
) {
  return database
    .select({
      id: workspaces.id,
      workingDir: workspaces.workingDir,
      isDirect: workspaces.isDirect,
      serviceState: workspaces.serviceState,
    })
    .from(workspaces)
    .where(eq(workspaces.id, workspaceId))
    .limit(1);
}

export async function getProjectStatusIdsAndNames(
  projectId: string,
  database: Database = db,
) {
  return database
    .select({ id: projectStatuses.id, name: projectStatuses.name })
    .from(projectStatuses)
    .where(eq(projectStatuses.projectId, projectId));
}

export async function getBoardIssueRows(
  projectId: string,
  archivedStatusIds: string[],
  database: Database = db,
) {
  return database
    .select({ id: issues.id, statusName: projectStatuses.name })
    .from(issues)
    .innerJoin(projectStatuses, eq(issues.statusId, projectStatuses.id))
    .where(
      archivedStatusIds.length === 0
        ? eq(issues.projectId, projectId)
        : and(eq(issues.projectId, projectId), notInArray(issues.statusId, archivedStatusIds)),
    );
}

export async function getProjectStatusesOrdered(
  projectId: string,
  database: Database = db,
) {
  return database
    .select()
    .from(projectStatuses)
    .where(eq(projectStatuses.projectId, projectId))
    .orderBy(projectStatuses.sortOrder);
}

export async function getBoardIssues(
  projectId: string,
  includeArchived: boolean,
  archivedStatusIds: string[],
  database: Database = db,
) {
  return database
    .select({
      id: issues.id,
      issueNumber: issues.issueNumber,
      title: issues.title,
      priority: issues.priority,
      issueType: issues.issueType,
      sortOrder: issues.sortOrder,
      statusId: issues.statusId,
      projectId: issues.projectId,
      createdAt: issues.createdAt,
      updatedAt: issues.updatedAt,
      statusChangedAt: issues.statusChangedAt,
      statusName: projectStatuses.name,
      skipAutoReview: issues.skipAutoReview,
      estimate: issues.estimate,
      externalKey: issues.externalKey,
      externalUrl: issues.externalUrl,
      checklistJson: issues.checklistJson,
      pinned: issues.pinned,
      milestoneId: issues.milestoneId,
    })
    .from(issues)
    .innerJoin(projectStatuses, eq(issues.statusId, projectStatuses.id))
    .where(
      includeArchived || archivedStatusIds.length === 0
        ? eq(issues.projectId, projectId)
        : and(eq(issues.projectId, projectId), notInArray(issues.statusId, archivedStatusIds)),
    )
    .orderBy(issues.sortOrder);
}

export async function getPreferenceValue(
  key: string,
  database: Database = db,
) {
  return database.select({ value: preferences.value }).from(preferences).where(eq(preferences.key, key)).limit(1);
}

export async function getGraphIssues(
  projectId: string,
  database: Database = db,
) {
  return database
    .select({
      id: issues.id,
      issueNumber: issues.issueNumber,
      title: issues.title,
      description: issues.description,
      priority: issues.priority,
      issueType: issues.issueType,
      sortOrder: issues.sortOrder,
      statusId: issues.statusId,
      projectId: issues.projectId,
      createdAt: issues.createdAt,
      updatedAt: issues.updatedAt,
      statusChangedAt: issues.statusChangedAt,
      statusName: projectStatuses.name,
      skipAutoReview: issues.skipAutoReview,
      estimate: issues.estimate,
      pinned: issues.pinned,
      milestoneId: issues.milestoneId,
    })
    .from(issues)
    .innerJoin(projectStatuses, eq(issues.statusId, projectStatuses.id))
    .where(eq(issues.projectId, projectId))
    .orderBy(issues.sortOrder);
}

export async function getCrossProjectIssues(
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
      sortOrder: issues.sortOrder,
      statusId: issues.statusId,
      projectId: issues.projectId,
      createdAt: issues.createdAt,
      updatedAt: issues.updatedAt,
      statusName: projectStatuses.name,
    })
    .from(issues)
    .innerJoin(projectStatuses, eq(issues.statusId, projectStatuses.id))
    .where(eq(issues.projectId, projectId))
    .orderBy(issues.sortOrder);
}

export async function getActiveWorkspaceCounts(database: Database = db) {
  // Count ONLY workspaces whose agent is genuinely running, using the canonical
  // allowlist (active/fixing/reviewing/awaiting-plan-approval) — the same SSOT the
  // board/CLI/monitor derive activity from (see workspace-activity-state.ts). The old
  // denylist (`NOT IN ('idle','closed')`) over-counted blocked/error/stopped/merged
  // workspaces, so the project selector's "N active agents" badge showed agents that
  // were not actually working.
  return database
    .select({
      projectId: issues.projectId,
      count: sql<number>`count(*)`,
    })
    .from(workspaces)
    .innerJoin(issues, eq(workspaces.issueId, issues.id))
    .where(inArray(workspaces.status, [...ACTIVE_WORKSPACE_STATUSES]))
    .groupBy(issues.projectId);
}

export async function getBoardSummaryRows(
  projectId: string,
  database: Database = db,
) {
  return database
    .select({
      statusId: projectStatuses.id,
      name: projectStatuses.name,
      sortOrder: projectStatuses.sortOrder,
      count: sql<number>`count(${issues.id})`,
    })
    .from(projectStatuses)
    .leftJoin(issues, eq(issues.statusId, projectStatuses.id))
    .where(eq(projectStatuses.projectId, projectId))
    .groupBy(projectStatuses.id, projectStatuses.name, projectStatuses.sortOrder)
    .orderBy(projectStatuses.sortOrder);
}
