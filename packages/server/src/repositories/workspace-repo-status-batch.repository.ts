import { and, eq, inArray, ne } from "drizzle-orm";
import { issues, repos, workspaces, workspaceDiffStatCache } from "@agentic-kanban/shared/schema";
import { db } from "../db/index.js";
import type { Database } from "../db/index.js";

export type BatchWorkspaceRow = {
  id: string;
  issueId: string;
  branch: string;
  status: string;
  mergedAt: string | null;
  workingDir: string | null;
  baseBranch: string | null;
  baseCommitSha: string | null;
  mergedHeadSha: string | null;
  diffStatCacheCheckedAt: string | null;
  diffStatCacheFilesChanged: number | null;
  diffStatCacheInsertions: number | null;
  diffStatCacheDeletions: number | null;
};

/** Every non-closed, non-direct workspace of a project — the batch's per-workspace facts. */
export async function listBatchWorkspaceRows(
  projectId: string,
  database: Database = db,
): Promise<BatchWorkspaceRow[]> {
  return database
    .select({
      id: workspaces.id,
      issueId: workspaces.issueId,
      branch: workspaces.branch,
      status: workspaces.status,
      mergedAt: workspaces.mergedAt,
      workingDir: workspaces.workingDir,
      baseBranch: workspaces.baseBranch,
      baseCommitSha: workspaces.baseCommitSha,
      mergedHeadSha: workspaces.mergedHeadSha,
      // #815: the diff-stat memo moved to `workspace_diff_stat_cache`. Aliased back to the
      // same field names, so every consumer of this projected row is untouched by the move.
      diffStatCacheCheckedAt: workspaceDiffStatCache.checkedAt,
      diffStatCacheFilesChanged: workspaceDiffStatCache.filesChanged,
      diffStatCacheInsertions: workspaceDiffStatCache.insertions,
      diffStatCacheDeletions: workspaceDiffStatCache.deletions,
    })
    .from(workspaces)
    .innerJoin(issues, eq(issues.id, workspaces.issueId))
    // #815: LEFT, not inner — a never-diffed workspace has no memo row and must still be
    // returned, or the batch silently drops every workspace it has not yet diffed.
    .leftJoin(workspaceDiffStatCache, eq(workspaceDiffStatCache.workspaceId, workspaces.id))
    .where(and(
      eq(issues.projectId, projectId),
      ne(workspaces.status, "closed"),
      eq(workspaces.isDirect, false),
    ));
}

export type BatchRepoRow = typeof repos.$inferSelect;

/** Every `repos` row (leading + siblings) spanned by the given workspace ids. */
export async function listBatchRepoRows(
  workspaceIds: string[],
  database: Database = db,
): Promise<BatchRepoRow[]> {
  if (workspaceIds.length === 0) return [];
  return database
    .select()
    .from(repos)
    .where(inArray(repos.workspaceId, workspaceIds));
}
