import { eq, inArray, sql } from "drizzle-orm";
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

// #346: these three used to be bare `database.select()` — i.e. every column of every
// row — to render a 32KB feed. On the dev project that pulled ~5.5MB per request
// (2.94MB of sessions.stats JSON across 397 sessions, 410KB of workspace scorecard /
// code-metrics / context-primer / setup-output blobs across 137 workspaces, and 2.07MB
// of comment bodies+payloads across 2110 comments), deserialized and then almost
// entirely discarded — on the project view's POLL path (measured min 2.1s, median 8.9s,
// max 17.9s). Each now names exactly the columns project-activity.service.ts reads.
// Keep these column lists in sync with that service: adding a field to an event means
// adding its column here, and the compiler will say so.

export async function getProjectActivityWorkspaces(issueIds: string[], database: Database = db) {
  return database
    .select({
      id: workspaces.id,
      issueId: workspaces.issueId,
      branch: workspaces.branch,
      createdAt: workspaces.createdAt,
      mergedAt: workspaces.mergedAt,
      closedAt: workspaces.closedAt,
      provider: workspaces.provider,
      claudeProfile: workspaces.claudeProfile,
    })
    .from(workspaces)
    .where(inArray(workspaces.issueId, issueIds));
}

export async function getProjectActivitySessions(workspaceIds: string[], database: Database = db) {
  return database
    .select({
      id: sessions.id,
      workspaceId: sessions.workspaceId,
      executor: sessions.executor,
      skillName: sessions.skillName,
      startedAt: sessions.startedAt,
      endedAt: sessions.endedAt,
      exitCode: sessions.exitCode,
      status: sessions.status,
      // NOT sessions.stats — 2.94MB of JSON on the dev project, never read here.
    })
    .from(sessions)
    .where(inArray(sessions.workspaceId, workspaceIds));
}

/**
 * How much of a comment body the feed fetches. The feed only ever shows an 80-char
 * preview (commentSummary in project-activity.service.ts), so a bounded prefix is
 * sufficient; the "..." suffix is driven by the row's TRUE length, not the prefix, so
 * truncation stays invisible. The margin over 80 covers whitespace collapsing — a body
 * whose first 300 characters collapse to under 80 visible ones is not a real comment.
 */
export const ACTIVITY_COMMENT_BODY_PREFIX_CHARS = 300;

export async function getProjectActivityComments(issueIds: string[], database: Database = db) {
  return database
    .select({
      id: issueComments.id,
      issueId: issueComments.issueId,
      workspaceId: issueComments.workspaceId,
      kind: issueComments.kind,
      author: issueComments.author,
      body: sql<string>`substr(${issueComments.body}, 1, ${ACTIVITY_COMMENT_BODY_PREFIX_CHARS})`,
      bodyLength: sql<number>`length(${issueComments.body})`,
      createdAt: issueComments.createdAt,
      // NOT issueComments.payload — JSON-encoded Q&A replay data, never read here.
    })
    .from(issueComments)
    .where(inArray(issueComments.issueId, issueIds));
}
