import { issues, workspaceIssueMembers, workspaces } from "@agentic-kanban/shared/schema";
import { and, eq, inArray, ne } from "drizzle-orm";
import { db } from "../db/index.js";
import { issueTextColumns } from "./projections.js";
import type { Database, TransactionClient } from "../db/index.js";

/**
 * Ticket groups (#661): membership queries for workspaces serving MORE than their
 * lead issue. The lead lives in `workspaces.issue_id`; this table holds only the
 * additional member issues, so every helper here is about the members.
 */

export async function insertWorkspaceIssueMembers(
  workspaceId: string,
  issueIds: string[],
  now: string,
  database: Database | TransactionClient = db,
): Promise<void> {
  if (issueIds.length === 0) return;
  await database.insert(workspaceIssueMembers).values(
    issueIds.map((issueId) => ({ workspaceId, issueId, createdAt: now })),
  );
}

/** Member issue ids of one workspace (empty for a plain single-ticket workspace). */
export async function listMemberIssueIds(
  workspaceId: string,
  database: Database = db,
): Promise<string[]> {
  const rows = await database
    .select({ issueId: workspaceIssueMembers.issueId })
    .from(workspaceIssueMembers)
    .where(eq(workspaceIssueMembers.workspaceId, workspaceId));
  return rows.map((r) => r.issueId);
}

/** Member issues of one workspace with the details prompts/reviews render. */
export async function listMemberIssues(
  workspaceId: string,
  database: Database = db,
): Promise<Array<{ id: string; issueNumber: number | null; title: string; description: string | null }>> {
  return database
    .select({ ...issueTextColumns })
    .from(workspaceIssueMembers)
    .innerJoin(issues, eq(workspaceIssueMembers.issueId, issues.id))
    .where(eq(workspaceIssueMembers.workspaceId, workspaceId));
}

/**
 * The GROUP LEAD issue's own number/title/description, in the same shape as
 * {@link listMemberIssues} — so a train review can render it into `{{members}}`
 * alongside the additional members. `workspaces.issue_id` never appears in
 * `workspace_issue_members` (that table holds only the ADDITIONAL tickets), so
 * without this a train review's own lead ticket carries no acceptance criteria
 * in the rendered block even though every other member does.
 */
export async function getLeadIssueForMembersBlock(
  issueId: string,
  database: Database = db,
): Promise<{ id: string; issueNumber: number | null; title: string; description: string | null } | undefined> {
  const rows = await database
    .select({ ...issueTextColumns })
    .from(issues)
    .where(eq(issues.id, issueId))
    .limit(1);
  return rows[0];
}

/**
 * Of the given issues, the ones currently served as a MEMBER of a live (non-closed)
 * group workspace. The auto-starters must treat these exactly like issues with an
 * open workspace of their own — a member issue sits In Progress with no row in
 * `workspaces.issue_id`, so without this check every monitor loop would start a
 * duplicate builder for it.
 */
export async function filterIssuesWithLiveGroupWorkspace(
  issueIds: string[],
  database: Database = db,
): Promise<Set<string>> {
  if (issueIds.length === 0) return new Set();
  const rows = await database
    .select({ issueId: workspaceIssueMembers.issueId })
    .from(workspaceIssueMembers)
    .innerJoin(workspaces, eq(workspaceIssueMembers.workspaceId, workspaces.id))
    .where(and(inArray(workspaceIssueMembers.issueId, issueIds), ne(workspaces.status, "closed")));
  return new Set(rows.map((r) => r.issueId));
}

/** Single-issue convenience over {@link filterIssuesWithLiveGroupWorkspace}. */
export async function hasLiveGroupWorkspace(
  issueId: string,
  database: Database = db,
): Promise<boolean> {
  const live = await filterIssuesWithLiveGroupWorkspace([issueId], database);
  return live.has(issueId);
}

/**
 * All live (non-closed) group workspaces any of the given issues is a member of —
 * used by board projections to show the group workspace on MEMBER cards too.
 */
export async function listLiveGroupWorkspacesForIssues(
  issueIds: string[],
  database: Database = db,
): Promise<Array<{ issueId: string; workspaceId: string; leadIssueId: string }>> {
  if (issueIds.length === 0) return [];
  return database
    .select({
      issueId: workspaceIssueMembers.issueId,
      workspaceId: workspaceIssueMembers.workspaceId,
      leadIssueId: workspaces.issueId,
    })
    .from(workspaceIssueMembers)
    .innerJoin(workspaces, eq(workspaceIssueMembers.workspaceId, workspaces.id))
    .where(and(inArray(workspaceIssueMembers.issueId, issueIds), ne(workspaces.status, "closed")));
}
