import { execGit } from "./internal.js";
import { ensureOnBranch } from "./branch-attach.js";

/**
 * Commit any uncommitted changes in a worktree so a rebase/merge can run on a clean tree.
 * Agents routinely leave small artifacts behind (a modified .gitignore, a generated
 * CLAUDE.local.md/HANDOFF.md) without committing them; a rebase refuses to run on a dirty
 * tree, so the auto-merge skips the workspace forever (an infinite "rebase conflict" loop
 * with an empty file list). Committing the leftovers preserves the work rather than
 * discarding or stalling it. Returns the number of files committed (0 if the tree was clean).
 */
export async function commitLeftoverChanges(worktreePath: string): Promise<number> {
  try {
    const statusOutput = await execGit(["status", "--porcelain"], worktreePath);
    const changedFiles = statusOutput.trim().split("\n").filter(Boolean);
    if (changedFiles.length === 0) return 0;
    await execGit(["add", "-A"], worktreePath);
    await execGit([
      "-c", "user.name=agentic-kanban",
      "-c", "user.email=board@agentic-kanban.local",
      "commit", "-m", "chore: commit leftover workspace changes before merge",
    ], worktreePath);
    console.log(`[git] committed ${changedFiles.length} leftover change(s) in ${worktreePath} before rebase`);
    return changedFiles.length;
  } catch (err) {
    console.log(`[git] failed to commit leftover changes in ${worktreePath}: ${err instanceof Error ? err.message : String(err)}`);
    return 0;
  }
}

/**
 * Fetch the latest base branch and rebase the current workspace branch onto it.
 * Returns the diff ref to use for review (e.g., "origin/main" or "main").
 * On conflict, aborts the rebase and returns success=false with conflicting file names.
 */
export async function prepareForReview(
  worktreePath: string,
  baseBranch: string,
): Promise<{ diffRef: string; success: boolean; conflictingFiles?: string[]; error?: string; uncommittedChanges?: string[] }> {
  // Abort any in-progress rebase from a prior failed attempt (idempotent retry safety)
  try {
    await execGit(["rebase", "--abort"], worktreePath);
    console.log(`[git] aborted stale in-progress rebase in ${worktreePath}`);
  } catch {
    // No rebase in progress — expected
  }

  // Commit any uncommitted changes so the rebase runs on a clean tree. Bailing here (the old
  // behavior) made the auto-merge skip a workspace forever whenever an agent left a stray
  // .gitignore edit / CLAUDE.local.md behind — an infinite "rebase conflict" loop.
  await commitLeftoverChanges(worktreePath);

  // Try to fetch from origin (best effort — no remote is fine)
  try {
    await execGit(["fetch", "origin", baseBranch], worktreePath);
  } catch {
    // No remote configured — use local branches only
  }

  // Rebase onto the LOCAL base branch — that's where the board merges into
  // (mergeBranch targets the local default branch, never origin). In this
  // local-first app (manual merge only, no push), local master can be many
  // commits ahead of a stale origin/master; rebasing onto origin would replay
  // all local-only history and conflict spuriously. Fall back to the remote ref
  // only if the local base branch doesn't exist.
  let rebaseSource: string;
  try {
    await execGit(["rev-parse", "--verify", baseBranch], worktreePath);
    rebaseSource = baseBranch;
  } catch {
    rebaseSource = `origin/${baseBranch}`;
  }

  // Rebase the workspace branch onto the base branch
  try {
    await execGit(["rebase", rebaseSource], worktreePath);
  } catch (err) {
    // Rebase conflict — collect conflicting files, then abort to leave worktree clean
    let conflictingFiles: string[] | undefined;
    try {
      const unmerged = await execGit(["diff", "--name-only", "--diff-filter=U"], worktreePath);
      conflictingFiles = unmerged.trim().split("\n").filter(Boolean);
    } catch { /* best effort */ }
    try {
      await execGit(["rebase", "--abort"], worktreePath);
    } catch { /* best effort */ }
    return { diffRef: rebaseSource, success: false, conflictingFiles, error: err instanceof Error ? err.message : String(err) };
  }

  return { diffRef: rebaseSource, success: true };
}

/**
 * Rebase the current branch onto the latest base branch.
 * On conflict, returns conflicting files and leaves rebase in-progress for resolution.
 */
export async function rebaseOntoBase(
  worktreePath: string,
  baseBranch: string,
  branch?: string,
  options: { preferLocalBase?: boolean } = {},
): Promise<{ success: boolean; conflictingFiles?: string[]; error?: string }> {
  // A dirty worktree makes `git rebase` fail with an empty conflict list ("rebase conflict: "),
  // which the merge queue then skips forever. Commit any leftover changes first. (#nnn)
  await commitLeftoverChanges(worktreePath);

  try {
    await execGit(["fetch", "origin", baseBranch], worktreePath);
  } catch { /* no remote */ }

  let source = baseBranch;
  if (!options.preferLocalBase) {
    try {
      await execGit(["rev-parse", "--verify", `remotes/origin/${baseBranch}`], worktreePath);
      source = `origin/${baseBranch}`;
    } catch { /* use local */ }
  }

  try {
    await execGit(["rebase", source], worktreePath);
    // Rebase can leave worktree in detached HEAD — reattach
    if (branch) {
      await ensureOnBranch(worktreePath, branch);
    }
    return { success: true };
  } catch (err) {
    try {
      const unmerged = await execGit(["diff", "--name-only", "--diff-filter=U"], worktreePath);
      const conflictingFiles = unmerged.trim().split("\n").filter(Boolean);
      return { success: false, conflictingFiles, error: err instanceof Error ? err.message : String(err) };
    } catch {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  }
}

/** Abort an in-progress rebase. */
export async function abortRebase(worktreePath: string): Promise<void> {
  await execGit(["rebase", "--abort"], worktreePath);
}

/** Check if a rebase is in progress in the worktree. */
export async function isRebaseInProgress(worktreePath: string): Promise<boolean> {
  try {
    const dir = (await execGit(["rev-parse", "--git-dir"], worktreePath)).trim();
    const { existsSync } = await import("node:fs");
    const { join: pathJoin } = await import("node:path");
    return existsSync(pathJoin(worktreePath, dir, "rebase-merge")) || existsSync(pathJoin(worktreePath, dir, "rebase-apply"));
  } catch {
    return false;
  }
}
