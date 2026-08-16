import { execGit } from "./internal.js";
import { ensureOnBranch } from "./branch-attach.js";
import { errorMessage } from "../error-message.js";

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
    console.log(`[git] failed to commit leftover changes in ${worktreePath}: ${errorMessage(err)}`);
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
    return { diffRef: rebaseSource, success: false, conflictingFiles, error: errorMessage(err) };
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
): Promise<{ success: boolean; conflictingFiles?: string[]; error?: string; branchSha?: string; baseSha?: string }> {
  // #274 — a rebase left IN PROGRESS by an earlier attempt makes this one fail instantly
  // ("a rebase is already in progress"), and the unmerged index entries `git diff
  // --diff-filter=U` then reports belong to THAT attempt, against a base that has since
  // moved. Observed live: the merge queue skipped two unrelated workspaces with the
  // identical reason `rebase conflict: <three files>` — files neither branch touched, which
  // were exactly the files another ticket had landed on master earlier that day. One of the
  // two actually merged clean; the other did conflict, but in a different file entirely. So
  // the queue refused mergeable work and pointed conflict resolution at the wrong files.
  //
  // `prepareForReview` has always aborted first; this path did not. Clear it here, and if
  // the abort itself fails (an `index.lock` held by another git process is the usual cause)
  // say THAT, rather than reporting a file list that describes a different rebase.
  if (await isRebaseInProgress(worktreePath)) {
    try {
      await execGit(["rebase", "--abort"], worktreePath);
      console.log(`[git] aborted a stale in-progress rebase in ${worktreePath} before rebasing onto ${baseBranch}`);
    } catch (err) {
      return {
        success: false,
        error:
          `a previous rebase is still in progress in ${worktreePath} and could not be aborted ` +
          `(${errorMessage(err)}) — resolve or abort it before retrying`,
      };
    }
  }

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

  // Pinned BEFORE the rebase so a reported conflict is attributable to a specific pair of
  // tips (#274, fix direction (c)): a verdict that names its inputs can be checked, and a
  // stale one is visible instead of merely wrong.
  const tips = await resolveTips(worktreePath, source);

  try {
    await execGit(["rebase", source], worktreePath);
    // Rebase can leave worktree in detached HEAD — reattach
    if (branch) {
      await ensureOnBranch(worktreePath, branch);
    }
    return { success: true, ...tips };
  } catch (err) {
    const error = errorMessage(err);
    // Only attribute unmerged index entries to THIS rebase when this rebase is the one that
    // stopped. If it never started (it failed for some other reason), whatever is in the
    // index belongs to something else and naming those files would be a fabrication.
    if (!(await isRebaseInProgress(worktreePath))) {
      return { success: false, error, ...tips };
    }
    try {
      const unmerged = await execGit(["diff", "--name-only", "--diff-filter=U"], worktreePath);
      const conflictingFiles = unmerged.trim().split("\n").filter(Boolean);
      return { success: false, conflictingFiles, error, ...tips };
    } catch {
      return { success: false, error, ...tips };
    }
  }
}

/** Best-effort branch/base tips for conflict attribution — never throws. */
async function resolveTips(worktreePath: string, baseRef: string): Promise<{ branchSha?: string; baseSha?: string }> {
  const read = async (ref: string) => {
    try {
      return (await execGit(["rev-parse", ref], worktreePath)).trim() || undefined;
    } catch {
      return undefined;
    }
  };
  const [branchSha, baseSha] = await Promise.all([read("HEAD"), read(baseRef)]);
  return { branchSha, baseSha };
}

/** Abort an in-progress rebase. */
export async function abortRebase(worktreePath: string): Promise<void> {
  await execGit(["rebase", "--abort"], worktreePath);
}

/** Check if a rebase is in progress in the worktree. */
export async function isRebaseInProgress(worktreePath: string): Promise<boolean> {
  try {
    // Must use --absolute-git-dir, not --git-dir: in a linked worktree --git-dir returns an
    // ABSOLUTE path (e.g. .../.git/worktrees/<name>), and path.join does not reset on an
    // absolute segment (that's path.resolve), so joining it onto worktreePath produced a
    // nonexistent path and this always returned false (#147).
    const dir = (await execGit(["rev-parse", "--absolute-git-dir"], worktreePath)).trim();
    const { existsSync } = await import("node:fs");
    const { join: pathJoin } = await import("node:path");
    return existsSync(pathJoin(dir, "rebase-merge")) || existsSync(pathJoin(dir, "rebase-apply"));
  } catch {
    return false;
  }
}
