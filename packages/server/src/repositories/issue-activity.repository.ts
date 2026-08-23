import { eq, asc, desc } from "drizzle-orm";
import { workspaces, sessions, issueComments, issues, projectStatuses } from "@agentic-kanban/shared/schema";
import { db } from "../db/index.js";
import type { Database } from "../db/index.js";
import { firstRow } from "../lib/first-row.js";

export async function getIssueActivityRow(issueId: string, database: Database = db) {
  return firstRow(
    database
      .select({
        id: issues.id,
        createdAt: issues.createdAt,
        statusChangedAt: issues.statusChangedAt,
        statusName: projectStatuses.name,
      })
      .from(issues)
      .leftJoin(projectStatuses, eq(issues.statusId, projectStatuses.id))
      .where(eq(issues.id, issueId))
      .limit(1)
  );
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

/**
 * Comments for the activity feed, capped and newest-first (#738).
 *
 * Was `select()` (every column, incl. the JSON `payload`) with no LIMIT and ASCENDING order,
 * so an issue with 7,478 comments loaded all of them — and the feed then sorts newest-first
 * and the panel shows a window, so the older rows were fetched only to be discarded. Two
 * changes: take the newest `limit` rows, and select only the four columns the feed maps into
 * an ActivityEvent — `payload` is Q&A replay data that this path has never read.
 */
export const ISSUE_ACTIVITY_COMMENT_LIMIT = 200;

export async function getIssueActivityComments(
  issueId: string,
  database: Database = db,
  limit: number = ISSUE_ACTIVITY_COMMENT_LIMIT,
) {
  return database
    .select({
      id: issueComments.id,
      kind: issueComments.kind,
      author: issueComments.author,
      body: issueComments.body,
      workspaceId: issueComments.workspaceId,
      createdAt: issueComments.createdAt,
    })
    .from(issueComments)
    .where(eq(issueComments.issueId, issueId))
    .orderBy(desc(issueComments.createdAt), desc(issueComments.id))
    .limit(limit);
}
