import { eq, inArray } from "drizzle-orm";
import { issues, workspaces, sessions, issueComments, projectStatuses } from "@agentic-kanban/shared/schema";
import { db } from "../db/index.js";
import type { Database } from "../db/index.js";

export async function getProjectActivityIssues(projectId: string, database: Database = db) {
  return database
    .select({
      id: issues.id,
      issueNumber: issues.issueNumber,
      title: issues.title,
      createdAt: issues.createdAt,
      statusChangedAt: issues.statusChangedAt,
      statusName: projectStatuses.name,
    })
    .from(issues)
    .leftJoin(projectStatuses, eq(issues.statusId, projectStatuses.id))
    .where(eq(issues.projectId, projectId));
}

export async function getProjectActivityWorkspaces(issueIds: string[], database: Database = db) {
  return database
    .select()
    .from(workspaces)
    .where(inArray(workspaces.issueId, issueIds));
}

export async function getProjectActivitySessions(workspaceIds: string[], database: Database = db) {
  return database
    .select()
    .from(sessions)
    .where(inArray(sessions.workspaceId, workspaceIds));
}

export async function getProjectActivityComments(issueIds: string[], database: Database = db) {
  return database
    .select()
    .from(issueComments)
    .where(inArray(issueComments.issueId, issueIds));
}
