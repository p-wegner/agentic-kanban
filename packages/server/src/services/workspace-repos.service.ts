/**
 * Multi-repo workspace support (full-peers model): provisioning and cleanup of the
 * SIBLING worktrees created for a project's additional repos. The leading repo's
 * worktree stays on the workspaces row and is handled by the legacy paths; both
 * functions here are strict no-ops for single-repo projects (no `repos` rows),
 * which is the zero-regression mechanism.
 */

import type { Database, TransactionClient } from "../db/index.js";
import { listProjectRepos, listWorkspaceRepos, insertWorkspaceRepo, type RepoRow } from "../repositories/repo.repository.js";
import type { GitService } from "./workspace-internals.js";

/** A sibling worktree provisioned for one additional repo of the project. */
export interface SiblingWorktree {
  path: string;
  name: string | null;
  worktreePath: string;
  branch: string;
  baseBranch: string;
  baseCommitSha: string | null;
}

/**
 * Create a worktree on `branch` in every additional repo of the project (same branch
 * name as the leading repo — worktrees are namespaced per repo root, so they never
 * collide on disk). Throws on the first failure: full-peers semantics require every
 * repo present, and the caller's rollback removes whatever was already created.
 */
export async function provisionSiblingWorktrees(params: {
  gitService: GitService;
  database: Database;
  projectId: string;
  branch: string;
}): Promise<SiblingWorktree[]> {
  const { gitService, database, projectId, branch } = params;
  const projectRepos = await listProjectRepos(projectId, database);
  if (projectRepos.length === 0) return [];

  const provisioned: SiblingWorktree[] = [];
  for (const repo of projectRepos) {
    const baseBranch = repo.defaultBranch;
    if (!baseBranch) {
      throw new Error(
        `Additional repo ${repo.name ?? repo.path} has no default branch — re-add it or set one.`,
      );
    }
    const baseCommitSha = await gitService.revParse(repo.path, baseBranch);
    const worktreePath = await gitService.createWorktree(repo.path, branch, baseBranch);
    provisioned.push({ path: repo.path, name: repo.name, worktreePath, branch, baseBranch, baseCommitSha });
  }
  return provisioned;
}

/** Persist the per-workspace worktree records inside the caller's transaction. */
export async function insertSiblingWorktreeRecords(
  workspaceId: string,
  projectId: string,
  siblings: SiblingWorktree[],
  database: Database | TransactionClient,
): Promise<void> {
  for (const s of siblings) {
    await insertWorkspaceRepo({
      workspaceId,
      projectId,
      path: s.path,
      name: s.name,
      worktreePath: s.worktreePath,
      branch: s.branch,
      baseBranch: s.baseBranch,
      baseCommitSha: s.baseCommitSha,
    }, database);
  }
}

/**
 * Compensating rollback for sibling worktrees provisioned before a create failure
 * (mirror of rollbackOrphanedWorktree for the leading repo). Best-effort per repo.
 */
export async function rollbackSiblingWorktrees(
  gitService: GitService,
  siblings: SiblingWorktree[],
): Promise<void> {
  for (const s of siblings) {
    try {
      await gitService.removeWorktree(s.path, s.worktreePath);
    } catch (err) {
      console.warn(`[workspaces] failed to remove sibling worktree ${s.worktreePath}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

/**
 * Remove the workspace's sibling worktrees AND their branches. Branch deletion is
 * mandatory (force): a stale branch left in a sibling repo would be silently reused
 * by the next workspace on the same branch name, basing it on an old commit.
 * Best-effort per repo; never throws. The `repos` rows themselves are removed by
 * cascade-delete when the workspace row goes away, so they are left untouched here
 * (they double as the merge audit trail via mergedHeadSha).
 */
export async function cleanupSiblingWorktrees(
  gitService: GitService,
  workspaceId: string,
  database: Database,
): Promise<void> {
  let rows: RepoRow[];
  try {
    rows = await listWorkspaceRepos(workspaceId, database);
  } catch (err) {
    console.warn(`[workspaces] sibling cleanup: failed to list repos for ${workspaceId}: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }
  for (const repo of rows) {
    if (repo.worktreePath) {
      try {
        await gitService.removeWorktree(repo.path, repo.worktreePath);
      } catch (err) {
        console.warn(`[workspaces] sibling cleanup: failed to remove worktree ${repo.worktreePath}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    if (repo.branch) {
      try {
        await gitService.deleteBranch(repo.path, repo.branch, { force: true });
      } catch (err) {
        console.warn(`[workspaces] sibling cleanup: failed to delete branch ${repo.branch} in ${repo.path}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }
}
