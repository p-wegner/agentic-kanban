import { issues, preferences, projectStatuses, projects, sessions, workspaces } from "@agentic-kanban/shared/schema";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { db } from "../db/index.js";
import type { Database } from "../db/index.js";

export async function getAllPreferences(
  database: Database = db,
): Promise<Array<{ key: string; value: string }>> {
  return database.select().from(preferences);
}

export async function getActiveAutodriveWorkspaceRows(
  projectIds: string[],
  activeAutodriveStatusNames: string[],
  activeWorkspaceStatuses: string[],
  database: Database = db,
) {
  return database.select({
    projectId: projects.id,
    projectName: projects.name,
    issueId: issues.id,
    issueNumber: issues.issueNumber,
    issueTitle: issues.title,
    statusName: projectStatuses.name,
    issueUpdatedAt: issues.updatedAt,
    issueStatusChangedAt: issues.statusChangedAt,
    workspaceId: workspaces.id,
    workspaceStatus: workspaces.status,
    workspaceUpdatedAt: workspaces.updatedAt,
    workspaceCreatedAt: workspaces.createdAt,
    readyForMerge: workspaces.readyForMerge,
  }).from(workspaces)
    .innerJoin(issues, eq(workspaces.issueId, issues.id))
    .innerJoin(projects, eq(issues.projectId, projects.id))
    .innerJoin(projectStatuses, eq(issues.statusId, projectStatuses.id))
    .where(and(
      inArray(issues.projectId, projectIds),
      inArray(projectStatuses.name, activeAutodriveStatusNames),
      inArray(workspaces.status, activeWorkspaceStatuses),
    ));
}

export async function getLatestSessionForWorkspace(
  workspaceId: string,
  database: Database = db,
) {
  const [latestSession] = await database.select({
    id: sessions.id,
    status: sessions.status,
    startedAt: sessions.startedAt,
    endedAt: sessions.endedAt,
    stats: sessions.stats,
    triggerType: sessions.triggerType,
  }).from(sessions)
    .where(eq(sessions.workspaceId, workspaceId))
    .orderBy(desc(sessions.startedAt))
    .limit(1);
  return latestSession ?? null;
}

export async function getFixAndMergeSessionCount(
  workspaceId: string,
  database: Database = db,
): Promise<number> {
  const fixCountRows = await database.select({ count: sql<number>`count(*)` }).from(sessions)
    .where(and(eq(sessions.workspaceId, workspaceId), eq(sessions.triggerType, "fix-and-merge")));
  return Number(fixCountRows[0]?.count ?? 0);
}

export async function getProgressIssueRows(
  projectIds: string[],
  database: Database = db,
) {
  return database.select({
    projectId: issues.projectId,
    updatedAt: issues.updatedAt,
    statusChangedAt: issues.statusChangedAt,
  }).from(issues)
    .where(inArray(issues.projectId, projectIds));
}

export async function getProgressWorkspaceRows(
  projectIds: string[],
  database: Database = db,
) {
  return database.select({
    projectId: issues.projectId,
    createdAt: workspaces.createdAt,
    updatedAt: workspaces.updatedAt,
    mergedAt: workspaces.mergedAt,
  }).from(workspaces)
    .innerJoin(issues, eq(workspaces.issueId, issues.id))
    .where(inArray(issues.projectId, projectIds));
}

export async function getProgressSessionRows(
  projectIds: string[],
  database: Database = db,
) {
  return database.select({
    projectId: issues.projectId,
    startedAt: sessions.startedAt,
    endedAt: sessions.endedAt,
  }).from(sessions)
    .innerJoin(workspaces, eq(sessions.workspaceId, workspaces.id))
    .innerJoin(issues, eq(workspaces.issueId, issues.id))
    .where(inArray(issues.projectId, projectIds));
}
