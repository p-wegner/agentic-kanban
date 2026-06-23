import { execGit } from "./internal.js";
import { pruneWorktrees } from "./worktree.js";

/** List all local and remote branches, sorted by most recent committer date. */
export async function listBranches(
  repoPath: string,
): Promise<{ local: string[]; remote: string[] }> {
  const output = await execGit(["branch", "--all", "--sort=-committerdate"], repoPath);
  const local: string[] = [];
  const remote: string[] = [];

  for (const raw of output.split("\n")) {
    const line = raw.trim().replace(/^\* /, "");
    if (!line) continue;

    if (line.startsWith("remotes/origin/")) {
      const name = line.slice("remotes/origin/".length).replace(/\r$/, "");
      if (name !== "HEAD") {
        remote.push(name);
      }
    } else {
      local.push(line.replace(/\r$/, ""));
    }
  }

  return { local, remote };
}

/**
 * Delete a local branch.
 *
 * Defaults to a SAFE delete (`-d`), which refuses to drop a branch that is not
 * fully merged into its upstream/HEAD — appropriate for post-merge cleanup where
 * the work has already landed. Pass `force: true` for `-D` to discard an
 * unmerged/abandoned branch (e.g. tearing down a workspace whose work is being
 * thrown away, so a recreated dependent re-cuts a fresh branch — #781).
 */
export async function deleteBranch(
  repoPath: string,
  branch: string,
  options?: { force?: boolean },
): Promise<void> {
  const flag = options?.force ? "-D" : "-d";
  try {
    await execGit(["branch", flag, branch], repoPath);
  } catch (err) {
    if (!isBranchCheckedOutElsewhereError(err)) throw err;
    await pruneWorktrees(repoPath);
    await execGit(["branch", flag, branch], repoPath);
  }
}

function isBranchCheckedOutElsewhereError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return message.includes("Cannot delete branch") && message.includes("checked out at");
}

/** Get the current branch name of a repo. */
export async function getCurrentBranch(repoPath: string): Promise<string> {
  const output = await execGit(["rev-parse", "--abbrev-ref", "HEAD"], repoPath);
  return output.trim();
}

/** Get the current HEAD commit SHA (full 40-character hash). */
export async function getHeadCommitSha(repoPath: string): Promise<string> {
  const output = await execGit(["rev-parse", "HEAD"], repoPath);
  return output.trim();
}

/** Resolve a ref to its commit SHA (e.g. "HEAD"). */
export async function revParse(repoPath: string, ref: string): Promise<string> {
  return (await execGit(["rev-parse", ref], repoPath)).trim();
}

/** Return true when ancestorRef is reachable from descendantRef. */
export async function isAncestor(
  repoPath: string,
  ancestorRef: string,
  descendantRef: string,
): Promise<boolean> {
  try {
    await execGit(["merge-base", "--is-ancestor", ancestorRef, descendantRef], repoPath);
    return true;
  } catch {
    return false;
  }
}
