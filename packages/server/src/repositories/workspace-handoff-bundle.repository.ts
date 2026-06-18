import { and, desc, eq, inArray } from "drizzle-orm";
import { diffComments, issues, projects, projectStatuses, sessionMessages, sessions, workspaces } from "@agentic-kanban/shared/schema";
import { db } from "../db/index.js";
import type { Database } from "../db/index.js";

export async function getHandoffBundleRow(workspaceId: string, database: Database = db) {
  const rows = await database
    .select({
      issueNumber: issues.issueNumber,
      issueTitle: issues.title,
      issueDescription: issues.description,
      statusName: projectStatuses.name,
      repoPath: projects.repoPath,
      defaultBranch: projects.defaultBranch,
      wsId: workspaces.id,
      branch: workspaces.branch,
      baseBranch: workspaces.baseBranch,
      baseCommitSha: workspaces.baseCommitSha,
      status: workspaces.status,
      isDirect: workspaces.isDirect,
      workingDir: workspaces.workingDir,
      createdAt: workspaces.createdAt,
      closedAt: workspaces.closedAt,
      mergedAt: workspaces.mergedAt,
    })
    .from(workspaces)
    .innerJoin(issues, eq(workspaces.issueId, issues.id))
    .innerJoin(projects, eq(issues.projectId, projects.id))
    .leftJoin(projectStatuses, eq(issues.statusId, projectStatuses.id))
    .where(eq(workspaces.id, workspaceId))
    .limit(1);
  return rows[0] ?? null;
}

export async function getHandoffBundleSessions(workspaceId: string, database: Database = db) {
  return database
    .select({
      id: sessions.id,
      triggerType: sessions.triggerType,
      status: sessions.status,
      startedAt: sessions.startedAt,
      endedAt: sessions.endedAt,
      exitCode: sessions.exitCode,
    })
    .from(sessions)
    .where(eq(sessions.workspaceId, workspaceId))
    .orderBy(desc(sessions.startedAt));
}

export async function getHandoffBundleSessionMessages(sessionIds: string[], database: Database = db) {
  return database
    .select({ type: sessionMessages.type, data: sessionMessages.data, sessionId: sessionMessages.sessionId })
    .from(sessionMessages)
    .where(inArray(sessionMessages.sessionId, sessionIds));
}

export async function getHandoffBundleDiffComments(workspaceId: string, database: Database = db) {
  return database
    .select({ filePath: diffComments.filePath, lineNumNew: diffComments.lineNumNew, body: diffComments.body })
    .from(diffComments)
    .where(and(eq(diffComments.workspaceId, workspaceId)))
    .orderBy(diffComments.createdAt);
}
