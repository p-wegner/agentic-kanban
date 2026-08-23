import { workspaces, issues, projectStatuses, sessions, sessionMessages, workspaceConflictCache } from "@agentic-kanban/shared/schema";
import { eq, inArray, and, desc } from "drizzle-orm";
import { db } from "../db/index.js";
import type { Database } from "../db/index.js";
import { projectStatusIdName, sessionLifecycleColumns } from "./projections.js";
import { listProjectStatusIdNames } from "./project-status.repository.js";

export async function getProjectStatusRows(
  projectId: string,
  database: Database = db,
) {
  // Order-INDEPENDENT (#773): the caller reduces these to a Set of terminal status ids and
  // a Map<id, name>; neither reads a position.
  return listProjectStatusIdNames(projectId, database);
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
      // #815: the conflict memo moved to `workspace_conflict_cache`. Aliased back to the same
      // field names, so every consumer of this projected row is untouched by the move.
      conflictCacheCheckedAt: workspaceConflictCache.checkedAt,
      conflictCacheHasConflicts: workspaceConflictCache.hasConflicts,
      conflictCacheFiles: workspaceConflictCache.files,
      diffStatCacheCheckedAt: workspaces.diffStatCacheCheckedAt,
      diffStatCacheFilesChanged: workspaces.diffStatCacheFilesChanged,
      diffStatCacheInsertions: workspaces.diffStatCacheInsertions,
      diffStatCacheDeletions: workspaces.diffStatCacheDeletions,
      updatedAt: workspaces.updatedAt,
    })
    .from(workspaces)
    // #815: LEFT, not inner — a never-probed workspace has no memo row and must still be
    // returned, or every risk signal on a fresh workspace disappears.
    .leftJoin(workspaceConflictCache, eq(workspaceConflictCache.workspaceId, workspaces.id))
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
      ...sessionLifecycleColumns,
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
