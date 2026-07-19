import { execGit, isGitWorkingTree } from "./internal.js";
import { revParse, isAncestor } from "./branch.js";

/** Get the number of commits on HEAD that are not reachable from baseBranch. */
export async function getCommitCountAhead(
  worktreePath: string,
  baseBranch: string,
): Promise<number | null> {
  if (!isGitWorkingTree(worktreePath)) return null;
  try {
    const output = await execGit(["rev-list", "--count", `${baseBranch}..HEAD`], worktreePath);
    const trimmed = output.trim();
    if (!trimmed) return null;
    const count = Number.parseInt(trimmed, 10);
    return Number.isNaN(count) ? null : count;
  } catch {
    return null;
  }
}

/** Get the latest commit SHA (short) and message on the current branch. Returns null when no commits exist. */
export async function getLatestCommit(
  worktreePath: string,
): Promise<{ sha: string; message: string } | null> {
  try {
    const output = await execGit(["log", "-1", "--format=%h\t%s"], worktreePath);
    const trimmed = output.trim();
    if (!trimmed) return null;
    const tabIdx = trimmed.indexOf("\t");
    if (tabIdx === -1) return null;
    return { sha: trimmed.slice(0, tabIdx), message: trimmed.slice(tabIdx + 1) };
  } catch {
    return null;
  }
}

/**
 * Return a list of staged or unstaged changes to tracked files in repoPath.
 * Untracked (new) files are excluded because they do not block `git merge`.
 * An empty array means the working tree is clean and safe to merge into.
 */
export async function getUncommittedTrackedChanges(repoPath: string): Promise<string[]> {
  try {
    const output = await execGit(["status", "--porcelain", "--untracked-files=no"], repoPath);
    return output.trim().split("\n").filter(Boolean);
  } catch {
    return [];
  }
}

/** List commit summaries between two refs, newest first. */
export async function getCommitSummariesBetween(
  repoPath: string,
  fromRef: string,
  toRef: string,
): Promise<Array<{ sha: string; message: string }>> {
  try {
    const output = await execGit(["log", "--format=%h%x09%s", `${fromRef}..${toRef}`], repoPath);
    return output
      .trim()
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const tabIdx = line.indexOf("\t");
        return tabIdx === -1
          ? { sha: line, message: "" }
          : { sha: line.slice(0, tabIdx), message: line.slice(tabIdx + 1) };
      });
  } catch {
    return [];
  }
}

/**
 * List the subject line of each MERGE commit reachable from `ref`, newest first
 * (`git log --merges --format=%s`). Used by the hand-merged-branch reconciler (#113)
 * to recover which `feature/ak-<N>` branches were landed by a manual `--no-ff` merge
 * (no board workspace), so the linked issue can be auto-transitioned to Done.
 *
 * Bounded by `maxCount` (default 1000) so an ancient repo doesn't scan unboundedly.
 * Returns [] on any git error (unknown ref, not a repo) so callers degrade gracefully.
 */
export async function getMergeCommitSubjects(
  repoPath: string,
  ref: string,
  maxCount = 1000,
): Promise<string[]> {
  try {
    const output = await execGit(
      ["log", "--merges", "--format=%s", `--max-count=${maxCount}`, ref],
      repoPath,
    );
    return output
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

/** A single commit's metadata as surfaced for a merged issue. */
export interface CommitInfo {
  /** Full 40-char SHA. */
  sha: string;
  /** Abbreviated (short) SHA. */
  shortSha: string;
  /** Commit subject line. */
  message: string;
  /** Author name. */
  author: string;
  /** Author date as an ISO-8601 string. */
  date: string;
}

/**
 * List the commits a branch contributed relative to `baseRef`, newest first.
 *
 * Resolves to the commits reachable from `branch` but NOT from `baseRef`
 * (`git log baseRef..branch`), excluding merge commits — i.e. the actual work
 * that landed for a merged workspace. `baseRef` is typically the workspace's
 * recorded `baseCommitSha` (the commit the branch was cut from); using that
 * exact point gives the precise set of commits this branch introduced, even
 * after the branch has been merged into the default branch.
 *
 * Returns [] when the refs cannot be resolved (deleted branch, unknown SHA) so
 * callers can treat "no commits" and "branch gone" uniformly.
 */
export async function getCommitsForBranch(
  repoPath: string,
  baseRef: string,
  branch: string,
): Promise<CommitInfo[]> {
  try {
    // %H full sha, %h short sha, %an author, %aI author ISO date, %s subject.
    // Unit-separator (\x1f) between fields, record-separator (\x1e) between commits —
    // both safe against tabs/newlines in commit messages.
    const output = await execGit(
      ["log", "--no-merges", "--format=%H%x1f%h%x1f%an%x1f%aI%x1f%s%x1e", `${baseRef}..${branch}`],
      repoPath,
    );
    return output
      .split("\x1e")
      .map((rec) => rec.replace(/^\s+/, ""))
      .filter(Boolean)
      .map((rec) => {
        const [sha = "", shortSha = "", author = "", date = "", message = ""] = rec.split("\x1f");
        return { sha, shortSha, author, date, message };
      })
      .filter((c) => c.sha);
  } catch {
    return [];
  }
}

/** Stage and commit specific paths in repoPath. Returns true when a commit was created. */
export async function commitPaths(
  repoPath: string,
  paths: string[],
  message: string,
): Promise<boolean> {
  const unique = [...new Set(paths.filter(Boolean))];
  if (unique.length === 0) return false;
  await execGit(["add", "-A", "--", ...unique], repoPath);
  try {
    await execGit(["diff", "--cached", "--quiet", "--", ...unique], repoPath);
    return false;
  } catch {
    await execGit(["commit", "-m", message, "--", ...unique], repoPath);
    return true;
  }
}

export type BranchTipAncestryResult =
  | { isAncestor: true; branchSha: string; baseSha: string }
  | { isAncestor: false; branchSha: string; baseSha: string }
  | { isAncestor: false; branchSha: null; reason: "branch-not-found" | "base-not-found" };

/**
 * Resolve whether a branch tip is already an ancestor of the base branch.
 *
 * Handles deleted-branch: when the branch ref is gone from the main repo but
 * a worktreeDir is provided, falls back to resolving HEAD from the worktree.
 * If the branch (or base) cannot be resolved at all, returns branchSha: null
 * with a reason — callers treat this as "needs further investigation" rather
 * than an error.
 */
export async function checkBranchTipIsAncestor(
  repoPath: string,
  branch: string,
  baseBranch: string,
  worktreeDir?: string,
): Promise<BranchTipAncestryResult> {
  let branchSha: string;
  try {
    branchSha = await revParse(repoPath, branch);
  } catch {
    if (worktreeDir) {
      try {
        branchSha = await revParse(worktreeDir, "HEAD");
      } catch {
        return { isAncestor: false, branchSha: null, reason: "branch-not-found" };
      }
    } else {
      return { isAncestor: false, branchSha: null, reason: "branch-not-found" };
    }
  }

  let baseSha: string;
  try {
    baseSha = await revParse(repoPath, baseBranch);
  } catch {
    return { isAncestor: false, branchSha: null, reason: "base-not-found" };
  }

  const ancestor = await isAncestor(repoPath, branchSha, baseSha);
  return ancestor
    ? { isAncestor: true, branchSha, baseSha }
    : { isAncestor: false, branchSha, baseSha };
}

/**
 * Count commits reachable from branchSha that are NOT reachable from baseSha.
 * Returns 0 on any git error (safer to skip reconciliation than to wrongly act).
 */
export async function countUniqueCommits(repoPath: string, baseSha: string, branchSha: string): Promise<number> {
  try {
    const out = await execGit(["rev-list", "--count", `${baseSha}..${branchSha}`], repoPath);
    return parseInt(out.trim(), 10) || 0;
  } catch {
    return 0;
  }
}

/**
 * Count how many commits base has that featureBranch does not (the "behind" count).
 * Throws on git error so callers can treat the failure as a safety signal.
 */
export async function countBehindCommits(repoPath: string, featureBranch: string, baseBranch: string): Promise<number> {
  const out = await execGit(["rev-list", "--count", `${featureBranch}..${baseBranch}`], repoPath);
  return parseInt(out.trim(), 10) || 0;
}
