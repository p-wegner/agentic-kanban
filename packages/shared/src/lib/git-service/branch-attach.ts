import { execGit } from "./internal.js";

/**
 * Ensure a worktree's HEAD is attached to the expected branch.
 * After a failed rebase or other operation, the worktree can end up in
 * detached HEAD state — commits go nowhere and merges become no-ops.
 * This reattaches HEAD to the branch, preserving any dangling commits.
 */
export async function ensureOnBranch(
  worktreePath: string,
  branch: string,
): Promise<void> {
  const current = await execGit(["rev-parse", "--abbrev-ref", "HEAD"], worktreePath);
  const currentBranch = current.trim();

  if (currentBranch !== branch) {
    // Worktree is detached or on wrong branch — get current HEAD commit
    const headCommit = (await execGit(["rev-parse", "HEAD"], worktreePath)).trim();

    // Force-update the branch ref to point at current HEAD (captures dangling commits)
    await execGit(["branch", "-f", branch, headCommit], worktreePath);

    // Reattach HEAD to the branch
    await execGit(["checkout", branch], worktreePath);
  }
}

/**
 * Sync the branch ref to match the worktree's HEAD.
 * Before merging, call this to ensure the branch pointer reflects
 * any commits the agent made (even if they were in detached HEAD).
 */
export async function syncBranchToHead(
  worktreePath: string,
  branch: string,
): Promise<boolean> {
  try {
    const headCommit = (await execGit(["rev-parse", "HEAD"], worktreePath)).trim();
    const branchCommit = (await execGit(["rev-parse", branch], worktreePath)).trim();

    if (headCommit !== branchCommit) {
      // HEAD is ahead of the branch (or detached) — update branch to match
      await execGit(["branch", "-f", branch, headCommit], worktreePath);
      return true;
    }
    return false;
  } catch {
    return false;
  }
}
