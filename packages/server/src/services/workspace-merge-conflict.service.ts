import { workspaces } from "@agentic-kanban/shared/schema";
import type { GitService } from "./workspace-internals.js";

export type WorkspaceMergeConflictResult =
  | { kind: "clear" }
  | { kind: "conflict"; conflictFiles: string[]; behindCount?: number };

/**
 * Decide whether a workspace branch can be merged into the base branch, WITHOUT
 * mutating the worktree.
 *
 * Why read-only matters (#761): the previous implementation rebased the worktree
 * branch in place whenever it was behind base, then aborted on conflict. That made
 * `/merge` non-idempotent — when landing a cluster of file-overlapping workspaces,
 * each merged member advanced base, so the next member became "behind" and got
 * re-rebased onto the moved base, re-reporting the SAME conflicting files forever.
 * A branch that had been manually merged clean with master still re-entered the
 * auto-rebase and re-conflicted. The loop stranded the whole cluster.
 *
 * The actual merge ({@link GitService.mergeBranch}) is a `git merge-tree`-based
 * plumbing merge that performs a correct 3-way merge of the branch into base — it
 * does not need the branch pre-rebased. So the conflict pre-check only needs to ask
 * the SAME question read-only: "would merge-tree of branch→base conflict?" We answer
 * that with {@link GitService.detectConflictsByBranch} (preferred — runs from the
 * main repo against branch refs, exactly mirroring `mergeBranch`) and fall back to
 * the worktree-relative {@link GitService.detectConflicts} when branch-level
 * detection is unavailable. Neither touches the working tree, so the check is
 * idempotent and converges: a mechanically-mergeable cluster member always reports
 * `clear` and lands, instead of re-conflicting on a replayed rebase.
 */
export async function detectWorkspaceMergeConflicts(args: {
  workspace: typeof workspaces.$inferSelect;
  repoPath: string;
  baseBranch: string;
  gitService: GitService;
}): Promise<WorkspaceMergeConflictResult> {
  const { workspace, repoPath, baseBranch, gitService } = args;
  if (!workspace.workingDir) return { kind: "clear" };

  // "behind" is informational only now (surfaces a clearer error message and lets
  // the orchestrator know the cluster member was stale). It NEVER triggers a rebase.
  const behindCount = await countBehindCommitsSafe(repoPath, workspace.branch, baseBranch, gitService);

  // Read-only 3-way conflict detection — identical merge semantics to mergeBranch.
  // Prefer the branch-level check from the main repo (mirrors mergeBranch exactly and
  // is independent of any partially-rewritten worktree state); fall back to the
  // worktree-relative merge-tree if branch-level detection isn't wired up.
  const conflicts = await detectConflictsReadOnly(repoPath, workspace, baseBranch, gitService);
  if (conflicts.hasConflicts) {
    return behindCount > 0
      ? { kind: "conflict", conflictFiles: conflicts.conflictingFiles, behindCount }
      : { kind: "conflict", conflictFiles: conflicts.conflictingFiles };
  }

  return { kind: "clear" };
}

/**
 * Read-only conflict detection mirroring {@link GitService.mergeBranch}'s 3-way merge.
 * Prefers `detectConflictsByBranch` (main-repo, branch-ref based — the exact operation
 * the real merge performs); falls back to the worktree-relative `detectConflicts`.
 */
async function detectConflictsReadOnly(
  repoPath: string,
  workspace: typeof workspaces.$inferSelect,
  baseBranch: string,
  gitService: GitService,
): Promise<{ hasConflicts: boolean; conflictingFiles: string[] }> {
  if (typeof gitService.detectConflictsByBranch === "function") {
    try {
      return await gitService.detectConflictsByBranch(repoPath, workspace.branch, baseBranch);
    } catch {
      // merge-tree from the repo failed (e.g. ref not resolvable from main checkout) —
      // fall through to the worktree-relative check.
    }
  }
  if (!workspace.workingDir) return { hasConflicts: false, conflictingFiles: [] };
  return gitService.detectConflicts(workspace.workingDir, baseBranch);
}

async function countBehindCommitsSafe(
  repoPath: string,
  branch: string,
  baseBranch: string,
  gitService: GitService,
): Promise<number> {
  if (typeof gitService.countBehindCommits !== "function") return 0;
  try {
    return await gitService.countBehindCommits(repoPath, branch, baseBranch);
  } catch {
    return 0;
  }
}
