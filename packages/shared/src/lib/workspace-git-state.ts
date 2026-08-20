import { and, eq } from "drizzle-orm";
import type { LibSQLDatabase } from "drizzle-orm/libsql";
import { repos, workspaces } from "../schema/index.js";
import type * as schema from "../schema/index.js";

/**
 * Writer for a workspace's LEADING-REPO GIT STATE — the five columns that are mirrored onto
 * the workspace's `is_leading` repos row (#226).
 *
 * Lifted into `packages/shared` for the same reason `setWorkspaceStatus` was (#967): both the
 * HTTP server and mcp-server need it, and the previous home (the server's `repo.repository`)
 * was unreachable from mcp-server. That unreachability is not a detail — it is exactly why
 * `close_workspace` in mcp-server was clearing `workingDir` on the workspace row alone, leaving
 * the leading row pointing at a worktree it had just deleted.
 *
 * Both sides are written together, so there is no ordering in which a reader sees one without
 * the other within a transaction.
 */
type WorkspaceGitStateDb = LibSQLDatabase<typeof schema> | Parameters<Parameters<LibSQLDatabase<typeof schema>["transaction"]>[0]>[0];

/** The workspace columns that have a leading-repo-row counterpart. */
export interface WorkspaceGitStatePatch {
  branch?: string | null;
  workingDir?: string | null;
  baseBranch?: string | null;
  baseCommitSha?: string | null;
  mergedHeadSha?: string | null;
}

/**
 * Mirror a git-state change onto the workspace's leading `repos` row.
 *
 * A workspace with no leading row is a silent no-op: `leadingRef`'s read-repair backfills it
 * on the next read, so a missing row self-heals rather than failing a close or a merge.
 */
export async function mirrorWorkspaceGitStateToLeadingRepo(
  database: WorkspaceGitStateDb,
  workspaceId: string,
  patch: WorkspaceGitStatePatch,
): Promise<void> {
  const set: Partial<typeof repos.$inferInsert> = {};
  if (patch.branch !== undefined) set.branch = patch.branch;
  if (patch.workingDir !== undefined) set.worktreePath = patch.workingDir;
  if (patch.baseBranch !== undefined) set.baseBranch = patch.baseBranch;
  if (patch.baseCommitSha !== undefined) set.baseCommitSha = patch.baseCommitSha;
  if (patch.mergedHeadSha !== undefined) set.mergedHeadSha = patch.mergedHeadSha;
  if (Object.keys(set).length === 0) return;
  await database
    .update(repos)
    .set(set)
    .where(and(eq(repos.workspaceId, workspaceId), eq(repos.isLeading, true)));
}

/**
 * Set a workspace's `workingDir` on BOTH sides — the workspace column and the leading repo row.
 *
 * The only sanctioned way to change it. `setWorkspaceStatus`'s `set` escape hatch used to be
 * the other way and could not mirror, so four close paths silently desynchronised the row; its
 * type now rejects these columns outright, which is what routes callers here.
 */
export async function setWorkspaceWorkingDir(
  database: WorkspaceGitStateDb,
  workspaceId: string,
  workingDir: string | null,
  now: string = new Date().toISOString(),
): Promise<void> {
  await database
    .update(workspaces)
    .set({ workingDir, updatedAt: now })
    .where(eq(workspaces.id, workspaceId));
  await mirrorWorkspaceGitStateToLeadingRepo(database, workspaceId, { workingDir });
}
