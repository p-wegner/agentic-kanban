import { eq, asc } from "drizzle-orm";
import { workspaces, sessions, issueComments, issues, projectStatuses } from "@agentic-kanban/shared/schema";
import { db } from "../db/index.js";
import type { Database } from "../db/index.js";

export async function getIssueActivityRow(issueId: string, database: Database = db) {
  const issueRows = await database
    .select({
      id: issues.id,
      createdAt: issues.createdAt,
      statusChangedAt: issues.statusChangedAt,
      statusName: projectStatuses.name,
    })
    .from(issues)
    .leftJoin(projectStatuses, eq(issues.statusId, projectStatuses.id))
    .where(eq(issues.id, issueId))
    .limit(1);
  return issueRows[0] ?? null;
}

export async function getIssueActivityWorkspaces(issueId: string, database: Database = db) {
  return database
    .select()
    .from(workspaces)
    .where(eq(workspaces.issueId, issueId))
    .orderBy(asc(workspaces.createdAt));
}

export async function getIssueActivityWorkspaceSessions(workspaceId: string, database: Database = db) {
  return database
    .select()
    .from(sessions)
    .where(eq(sessions.workspaceId, workspaceId))
    .orderBy(asc(sessions.startedAt));
}

export async function getIssueActivityComments(issueId: string, database: Database = db) {
  return database
    .select()
    .from(issueComments)
    .where(eq(issueComments.issueId, issueId))
    .orderBy(asc(issueComments.createdAt));
}
