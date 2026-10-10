import { and, eq, gt, isNotNull, lt, ne, asc, desc } from "drizzle-orm";
import { issueComments, workspaces } from "@agentic-kanban/shared/schema";
import { db as defaultDb, type Database } from "../db/index.js";

export type ReopenComment = { author: string; body: string; createdAt: string };

/** ISO time of the newest merge of ANY workspace of the issue, or null if it never landed. */
export async function getLastMergedAt(issueId: string, database: Database = defaultDb): Promise<string | null> {
  const rows = await database
    .select({ mergedAt: workspaces.mergedAt })
    .from(workspaces)
    .where(and(eq(workspaces.issueId, issueId), isNotNull(workspaces.mergedAt)))
    .orderBy(desc(workspaces.mergedAt))
    .limit(1);
  return rows[0]?.mergedAt ?? null;
}

/**
 * Human/agent notes added after the issue last merged — the reopen reason (#1343).
 * Machine-authored kinds (merge attempts, preflight verdicts) are not the reason.
 */
export async function listCommentsSinceLastMerge(
  issueId: string,
  database: Database = defaultDb,
): Promise<ReopenComment[]> {
  const lastMergedAt = await getLastMergedAt(issueId, database);
  if (!lastMergedAt) return [];
  return database
    .select({ author: issueComments.author, body: issueComments.body, createdAt: issueComments.createdAt })
    .from(issueComments)
    .where(and(
      eq(issueComments.issueId, issueId),
      eq(issueComments.kind, "note"),
      gt(issueComments.createdAt, lastMergedAt),
    ))
    .orderBy(asc(issueComments.createdAt));
}

/**
 * True when a DIFFERENT workspace of the issue merged before this workspace was created —
 * i.e. this workspace is a reopen attempt, so an earlier merge proves nothing about it (#1343).
 */
export async function hasMergeBeforeWorkspace(
  issueId: string,
  workspaceId: string,
  workspaceCreatedAt: string,
  database: Database = defaultDb,
): Promise<boolean> {
  const rows = await database
    .select({ id: workspaces.id })
    .from(workspaces)
    .where(and(
      eq(workspaces.issueId, issueId),
      ne(workspaces.id, workspaceId),
      isNotNull(workspaces.mergedAt),
      lt(workspaces.mergedAt, workspaceCreatedAt),
    ))
    .limit(1);
  return rows.length > 0;
}
