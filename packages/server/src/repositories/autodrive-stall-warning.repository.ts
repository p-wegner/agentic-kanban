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

export interface WorkspaceSessionSummary {
  id: string;
  status: string;
  startedAt: string;
  endedAt: string | null;
  stats: string | null;
  triggerType: string | null;
}

/**
 * Batched replacement for `getLatestSessionForWorkspace` + `getFixAndMergeSessionCount` (#349).
 * Those were called once EACH per active workspace from a serial loop — 2N synchronous libsql
 * round trips (82 on a board with 41 active workspaces) inside a phase measured at 203-265s.
 * One query for the whole set, reduced in JS, is the same answer with two round trips.
 */
export async function getSessionSummariesForWorkspaces(
  workspaceIds: string[],
  database: Database = db,
): Promise<Map<string, { latestSession: WorkspaceSessionSummary | null; fixAndMergeSessionCount: number }>> {
  const result = new Map<string, { latestSession: WorkspaceSessionSummary | null; fixAndMergeSessionCount: number }>();
  for (const id of workspaceIds) result.set(id, { latestSession: null, fixAndMergeSessionCount: 0 });
  if (workspaceIds.length === 0) return result;
  const rows = await database.select({
    workspaceId: sessions.workspaceId,
    id: sessions.id,
    status: sessions.status,
    startedAt: sessions.startedAt,
    endedAt: sessions.endedAt,
    stats: sessions.stats,
    triggerType: sessions.triggerType,
  }).from(sessions).where(inArray(sessions.workspaceId, workspaceIds));
  for (const row of rows) {
    const entry = result.get(row.workspaceId ?? "");
    if (!entry) continue;
    if (row.triggerType === "fix-and-merge") entry.fixAndMergeSessionCount += 1;
    // `ORDER BY started_at DESC LIMIT 1` per workspace, done once over the batch.
    if (!entry.latestSession || String(row.startedAt) > String(entry.latestSession.startedAt)) {
      entry.latestSession = { id: row.id, status: row.status, startedAt: row.startedAt, endedAt: row.endedAt, stats: row.stats, triggerType: row.triggerType };
    }
  }
  return result;
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

// The three progress queries below feed a per-project `MAX(timestamp)` reduction and nothing
// else. They used to SELECT every issue, workspace and SESSION row of every auto-driven project
// and materialise them as JS objects — on the dev board that is thousands of rows per scan, all
// of it discarded except one maximum per column, and all of it synchronous libsql work on the
// event loop (#349). Aggregating in SQL returns one row per project with the same maxima, so the
// `addProgress`/`maxIso` reduction downstream is unchanged.

export async function getProgressIssueRows(
  projectIds: string[],
  database: Database = db,
) {
  return database.select({
    projectId: issues.projectId,
    updatedAt: sql<string | null>`max(${issues.updatedAt})`,
    statusChangedAt: sql<string | null>`max(${issues.statusChangedAt})`,
  }).from(issues)
    .where(inArray(issues.projectId, projectIds))
    .groupBy(issues.projectId);
}

export async function getProgressWorkspaceRows(
  projectIds: string[],
  database: Database = db,
) {
  return database.select({
    projectId: issues.projectId,
    createdAt: sql<string | null>`max(${workspaces.createdAt})`,
    updatedAt: sql<string | null>`max(${workspaces.updatedAt})`,
    mergedAt: sql<string | null>`max(${workspaces.mergedAt})`,
  }).from(workspaces)
    .innerJoin(issues, eq(workspaces.issueId, issues.id))
    .where(inArray(issues.projectId, projectIds))
    .groupBy(issues.projectId);
}

export async function getProgressSessionRows(
  projectIds: string[],
  database: Database = db,
) {
  return database.select({
    projectId: issues.projectId,
    startedAt: sql<string | null>`max(${sessions.startedAt})`,
    endedAt: sql<string | null>`max(${sessions.endedAt})`,
  }).from(sessions)
    .innerJoin(workspaces, eq(sessions.workspaceId, workspaces.id))
    .innerJoin(issues, eq(workspaces.issueId, issues.id))
    .where(inArray(issues.projectId, projectIds))
    .groupBy(issues.projectId);
}
