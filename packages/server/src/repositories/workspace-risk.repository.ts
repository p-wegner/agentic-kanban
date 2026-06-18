import { workspaces, issues, projectStatuses, sessions, sessionMessages } from "@agentic-kanban/shared/schema";
import { eq, inArray, and, desc } from "drizzle-orm";
import { db } from "../db/index.js";
import type { Database } from "../db/index.js";

export async function getProjectStatusRows(
  projectId: string,
  database: Database = db,
) {
  return database
    .select({ id: projectStatuses.id, name: projectStatuses.name })
    .from(projectStatuses)
    .where(eq(projectStatuses.projectId, projectId));
}

export async function getProjectIssueRows(
  projectId: string,
  database: Database = db,
) {
  return database
    .select({ id: issues.id, issueNumber: issues.issueNumber, title: issues.title, statusId: issues.statusId })
    .from(issues)
    .where(eq(issues.projectId, projectId));
}

export async function getWorkspaceRiskRowsForIssues(
  issueIds: string[],
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
      conflictCacheCheckedAt: workspaces.conflictCacheCheckedAt,
      conflictCacheHasConflicts: workspaces.conflictCacheHasConflicts,
      conflictCacheFiles: workspaces.conflictCacheFiles,
      diffStatCacheCheckedAt: workspaces.diffStatCacheCheckedAt,
      diffStatCacheFilesChanged: workspaces.diffStatCacheFilesChanged,
      diffStatCacheInsertions: workspaces.diffStatCacheInsertions,
      diffStatCacheDeletions: workspaces.diffStatCacheDeletions,
      updatedAt: workspaces.updatedAt,
    })
    .from(workspaces)
    .where(and(
      inArray(workspaces.issueId, issueIds),
    ));
}

export async function getRiskSessionRowsDesc(
  workspaceIds: string[],
  database: Database = db,
) {
  return database
    .select({
      id: sessions.id,
      workspaceId: sessions.workspaceId,
      status: sessions.status,
      startedAt: sessions.startedAt,
      endedAt: sessions.endedAt,
      exitCode: sessions.exitCode,
      stats: sessions.stats,
      triggerType: sessions.triggerType,
    })
    .from(sessions)
    .where(inArray(sessions.workspaceId, workspaceIds))
    .orderBy(desc(sessions.startedAt));
}

export async function getSessionMessageDataForSessions(
  sessionIds: string[],
  database: Database = db,
) {
  return database
    .select({ sessionId: sessionMessages.sessionId, data: sessionMessages.data })
    .from(sessionMessages)
    .where(inArray(sessionMessages.sessionId, sessionIds));
}
