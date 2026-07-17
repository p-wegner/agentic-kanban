/**
 * Multi-repo workspace support (full-peers model): provisioning and cleanup of the
 * SIBLING worktrees created for a project's additional repos. The leading repo's
 * worktree stays on the workspaces row and is handled by the legacy paths; both
 * functions here are strict no-ops for single-repo projects (no `repos` rows),
 * which is the zero-regression mechanism.
 */

import { basename } from "node:path";
import { runSetupScript } from "@agentic-kanban/shared/lib/setup-script";
import type { Database, TransactionClient } from "../db/index.js";
import { listProjectRepos, listWorkspaceRepos, insertWorkspaceRepo, setWorkspaceRepoMergedSha, findLiveSiblingSharers, type RepoRow } from "../repositories/repo.repository.js";
import { WorkspaceError, acquireRepoMergeLock, type GitService } from "./workspace-internals.js";
import { runMergeCore } from "./merge-executor.service.js";

/** A sibling worktree provisioned for one additional repo of the project. */
export interface SiblingWorktree {
  path: string;
  name: string | null;
  worktreePath: string;
  branch: string;
  baseBranch: string;
  baseCommitSha: string | null;
  /** Per-repo compose file (relative to the repo), if this repo ships its own stack (#71). */
  composeFile: string | null;
}

/**
 * Create a worktree on `branch` in every additional repo of the project (same branch
 * name as the leading repo). Worktrees land at `dirname(repoPath)/.worktrees/...`,
 * which repos sharing a parent directory SHARE — the guaranteed layout for
 * clone-from-URL repos — so sibling worktrees are additionally namespaced by the
 * repo's directory name (`.worktrees/<repoDirName>/<branch>`) to keep them from
 * colliding with the leading repo's worktree (which keeps the un-namespaced
 * single-repo scheme). Throws on the first failure: full-peers semantics require
 * every repo present. Siblings already provisioned in earlier iterations are rolled
 * back HERE before the throw — the caller never sees the partial list (the throw
 * prevents the assignment), so an internal rollback is the only way they get removed.
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
  try {
    for (const repo of projectRepos) {
      const baseBranch = repo.defaultBranch;
      if (!baseBranch) {
        throw new Error(
          `Additional repo ${repo.name ?? repo.path} has no default branch — re-add it or set one.`,
        );
      }
      const baseCommitSha = await gitService.revParse(repo.path, baseBranch);
      const worktreePath = await gitService.createWorktree(repo.path, branch, baseBranch, {
        pathNamespace: basename(repo.path),
      });
      // Per-repo setup/install (#71): each additional repo may need its own deps ready in
      // its worktree before the agent runs (`pnpm install`, `cargo fetch`, `uv sync`, …).
      // Best-effort + non-fatal, mirroring the leading-repo setup script's semantics — a
      // failed sibling setup must not abort workspace creation.
      if (repo.setupScript && repo.setupScript.trim()) {
        try {
          const res = await runSetupScript(worktreePath, repo.setupScript);
          if (res.exitCode !== 0) {
            console.warn(`[workspace-repos] setup script for ${repo.name ?? repo.path} exited ${res.exitCode}: ${res.stderr.slice(0, 300)}`);
          }
        } catch (err) {
          console.warn(`[workspace-repos] setup script for ${repo.name ?? repo.path} failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      provisioned.push({ path: repo.path, name: repo.name, worktreePath, branch, baseBranch, baseCommitSha, composeFile: repo.composeFile ?? null });
    }
  } catch (err) {
    await rollbackSiblingWorktrees(gitService, provisioned);
    throw err;
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
      composeFile: s.composeFile,
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

/** A sibling repo that prevalidated clean and has commits to land. */
export interface SiblingMergePlan {
  repo: RepoRow;
  uniqueCommits: number;
}

/**
 * All-or-nothing prevalidation for the sibling repos of a multi-repo merge, run
 * BEFORE the leading repo's merge executes. Repos 0 commits ahead are skipped.
 * For each repo with commits: dirty-main guard, HEAD-on-baseBranch guard, and a
 * read-only merge-tree conflict check. ANY failure throws (nothing merged yet),
 * with a per-repo report — so a conflicted sibling can never leave the leading
 * repo merged and the sibling behind. Returns the repos to actually merge.
 * No-op ([]) for single-repo workspaces.
 */
export async function prevalidateSiblingMerges(params: {
  gitService: GitService;
  database: Database;
  workspaceId: string;
}): Promise<SiblingMergePlan[]> {
  const { gitService, database, workspaceId } = params;
  const rows = await listWorkspaceRepos(workspaceId, database);
  if (rows.length === 0) return [];

  const plans: SiblingMergePlan[] = [];
  const failures: string[] = [];
  for (const repo of rows) {
    const label = repo.name ?? repo.path;
    if (!repo.branch || !repo.baseBranch) continue;
    let uniqueCommits = 0;
    try {
      // countUniqueCommits(repoPath, baseSha, branchSha) = commits in base..branch.
      // It NEVER throws — it returns 0 on any git error — which would silently drop
      // an unverifiable repo from the merge plan. Resolve both refs first (revParse
      // throws) so a missing repo/ref FAILS prevalidation instead.
      await gitService.revParse(repo.path, repo.baseBranch);
      await gitService.revParse(repo.path, repo.branch);
      uniqueCommits = await gitService.countUniqueCommits(repo.path, repo.baseBranch, repo.branch);
    } catch (err) {
      failures.push(`${label}: could not count commits (${err instanceof Error ? err.message : String(err)})`);
      continue;
    }
    if (uniqueCommits === 0) continue;

    const dirty = await gitService.getUncommittedTrackedChanges(repo.path).catch(() => [] as string[]);
    if (dirty.length > 0) {
      failures.push(`${label}: main checkout has ${dirty.length} uncommitted tracked change(s)`);
      continue;
    }
    const head = await gitService.getCurrentBranch(repo.path).catch(() => "");
    if (head !== repo.baseBranch) {
      failures.push(`${label}: main checkout HEAD is on '${head}' but the workspace targets '${repo.baseBranch}'`);
      continue;
    }
    if (repo.worktreePath) {
      const conflicts = await gitService.detectConflicts(repo.worktreePath, repo.baseBranch).catch(() => null);
      if (conflicts?.hasConflicts) {
        failures.push(`${label}: merge conflicts in ${conflicts.conflictingFiles.slice(0, 5).join(", ")}${conflicts.conflictingFiles.length > 5 ? ", …" : ""}`);
        continue;
      }
    }
    plans.push({ repo, uniqueCommits });
  }

  if (failures.length > 0) {
    throw new WorkspaceError(
      `Multi-repo merge blocked — nothing was merged. Sibling repo prevalidation failed:\n- ${failures.join("\n- ")}`,
      "CONFLICT",
      { mergeReason: "sibling_prevalidation_failed", failures },
    );
  }
  return plans;
}

export interface SiblingMergeResult {
  repoId: string;
  name: string | null;
  path: string;
  merged: boolean;
  mergedHeadSha?: string;
  error?: string;
}

/**
 * Land the prevalidated sibling merges sequentially, AFTER the leading repo's merge.
 * Each repo is merged under its own repo merge lock (acquired one at a time — never
 * two sibling locks held together, so lock ordering can't deadlock) and its
 * merged_head_sha is stamped on the workspace-scoped repos row. A failure here is a
 * post-prevalidation race; it is reported per-repo, never thrown — the leading merge
 * has already landed and the caller records the partial state on the issue.
 */
export async function executeSiblingMerges(params: {
  gitService: GitService;
  database: Database;
  createBackup: (reason: string) => Promise<unknown>;
  workspaceId: string;
  plans: SiblingMergePlan[];
}): Promise<SiblingMergeResult[]> {
  const { gitService, database, createBackup, workspaceId, plans } = params;
  const results: SiblingMergeResult[] = [];
  for (const { repo } of plans) {
    const label = repo.name ?? repo.path;
    try {
      const core = await acquireRepoMergeLock(repo.path, workspaceId, () =>
        runMergeCore({
          repoPath: repo.path,
          branch: repo.branch!,
          targetBranch: repo.baseBranch!,
          gitService,
          createBackup,
          deferWorkingTreeSync: false,
          makeAncestryError: (branch, target) =>
            new Error(`Post-merge invariant violated in ${label}: '${branch}' is still not an ancestor of '${target}'`),
        }),
      );
      await setWorkspaceRepoMergedSha(repo.id, core.mergedHeadSha, database);
      results.push({ repoId: repo.id, name: repo.name, path: repo.path, merged: true, mergedHeadSha: core.mergedHeadSha });
      console.log(`[workspace-merge] sibling merge landed: ${label} ${repo.branch} → ${repo.baseBranch} (${core.mergedHeadSha})`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      results.push({ repoId: repo.id, name: repo.name, path: repo.path, merged: false, error: message });
      console.error(`[workspace-merge] sibling merge FAILED for ${label}: ${message}`);
    }
  }
  return results;
}

/**
 * Remove the workspace's sibling worktrees AND their branches. Branch deletion is
 * mandatory (force): a stale branch left in a sibling repo would be silently reused
 * by the next workspace on the same branch name, basing it on an old commit.
 * Best-effort per repo; never throws. The `repos` rows themselves are removed by
 * cascade-delete when the workspace row goes away, so they are left untouched here
 * (they double as the merge audit trail via mergedHeadSha).
 *
 * Shared-worktree guard: createWorktree's reuse path hands a second workspace on
 * the same branch the SAME sibling worktree, so multiple workspaces' repos rows can
 * reference one worktree/branch. A repo whose worktree or branch is still referenced
 * by another live (non-closed) workspace is skipped entirely — the sibling analog of
 * deleteWorkspace's findWorkspacesByWorkingDir guard for the leading worktree.
 */
export async function cleanupSiblingWorktrees(
  gitService: GitService,
  workspaceId: string,
  database: Database,
  opts: {
    /**
     * Preserve-work mode: a row WITHOUT mergedHeadSha is either "had no commits"
     * (safe to clean) or "carries unmerged commits" (work would be destroyed).
     * Probe via base..branch ancestry to tell them apart — an unmerged sibling
     * keeps its worktree AND branch for fix-up/recovery. Post-merge cleanup and
     * the branch-preserving paths (closeWorkspace, stale-worktree cleanup) set
     * this so sibling semantics mirror the leading repo's, which those paths never
     * force-delete either. deleteWorkspace leaves it off: the workspace is being
     * destroyed outright, force-delete everything (stale-branch reuse guard).
     */
    preserveUnmerged?: boolean;
  } = {},
): Promise<void> {
  let rows: RepoRow[];
  try {
    rows = await listWorkspaceRepos(workspaceId, database);
  } catch (err) {
    console.warn(`[workspaces] sibling cleanup: failed to list repos for ${workspaceId}: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }
  for (const repo of rows) {
    // Shared-worktree guard: skip repos whose worktree/branch another live
    // workspace still references — removing them would blank that workspace's
    // diffs, break its merge prevalidation, and force-delete its commits.
    // On a failed check, skip too (leak beats destroying shared work).
    try {
      const sharers = await findLiveSiblingSharers(repo, workspaceId, database);
      if (sharers.length > 0) {
        console.log(`[workspaces] sibling worktree ${repo.worktreePath ?? repo.branch} in ${repo.path} still referenced by ${sharers.length} other workspace(s) — skipping removal`);
        continue;
      }
    } catch (err) {
      console.warn(`[workspaces] sibling cleanup: sharer check failed for ${repo.path}: ${err instanceof Error ? err.message : String(err)} — skipping removal to be safe`);
      continue;
    }
    const mustPreserveCheck = opts.preserveUnmerged === true && !repo.mergedHeadSha;
    if (mustPreserveCheck && repo.branch && repo.worktreePath) {
      // Safe-delete probe requires the worktree gone first (the branch is checked
      // out there), so probe via merge-tree-free ancestry instead: 0 commits ahead
      // of base means nothing unmerged. countUniqueCommits NEVER throws (it returns
      // 0 on any git error) — which would read as "fully merged" and force-delete
      // unverified work — so resolve the refs with revParse (throws) first. A
      // branch ref that is GONE means there is nothing to preserve: fall through
      // to the normal worktree/branch cleanup.
      let branchExists = true;
      try {
        await gitService.revParse(repo.path, repo.branch);
      } catch {
        branchExists = false;
      }
      if (branchExists) {
        try {
          const base = repo.baseBranch ?? "HEAD";
          await gitService.revParse(repo.path, base);
          const ahead = await gitService.countUniqueCommits(repo.path, base, repo.branch);
          if (ahead > 0) {
            console.warn(`[workspaces] sibling cleanup: preserving ${repo.branch} in ${repo.path} — ${ahead} unmerged commit(s) (sibling merge did not land)`);
            continue;
          }
        } catch {
          console.warn(`[workspaces] sibling cleanup: preserving ${repo.branch} in ${repo.path} — could not verify merge state`);
          continue;
        }
      }
    }
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
