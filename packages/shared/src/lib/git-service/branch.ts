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

/**
 * What HEAD currently points at.
 *
 * - `branch`   — attached to a branch that has at least one commit,
 * - `unborn`   — attached to a branch with no commits yet (a fresh `git init`);
 *                committable, that is how any repo gets its first commit,
 * - `detached` — not on a branch at all.
 */
export type HeadState =
  | { kind: "branch"; branch: string }
  | { kind: "unborn"; branch: string }
  | { kind: "detached" };

/**
 * Classify HEAD, distinguishing an unborn branch from a detached one.
 *
 * `getCurrentBranch` cannot make that distinction: on an unborn branch
 * `rev-parse --abbrev-ref HEAD` does not return "HEAD", it FAILS with "ambiguous
 * argument 'HEAD'". A caller guarding only `branch === "HEAD"` therefore never sees
 * the empty-repo case as a state at all — it sees a thrown error, which is how the
 * board's scaffold commit silently never ran on freshly created projects (#47).
 */
export async function getHeadState(repoPath: string): Promise<HeadState> {
  let ref: string;
  try {
    ref = (await execGit(["symbolic-ref", "--quiet", "HEAD"], repoPath)).trim();
  } catch {
    return { kind: "detached" };
  }

  const branch = ref.replace(/^refs\/heads\//, "");
  try {
    await execGit(["rev-parse", "--verify", "--quiet", "HEAD"], repoPath);
  } catch {
    return { kind: "unborn", branch };
  }
  return { kind: "branch", branch };
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
