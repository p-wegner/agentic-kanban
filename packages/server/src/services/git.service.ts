import { execFile } from "node:child_process";
import { mkdir, readFile } from "node:fs/promises";
import { join, dirname, sep } from "node:path";

function execGit(args: string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("git", args, { cwd, maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        reject(new Error(`git ${args.join(" ")} failed: ${stderr || err.message}`));
      } else {
        resolve(stdout.toString());
      }
    });
  });
}

/**
 * List current git worktrees as an array of { path, branch } objects.
 */
export async function listWorktrees(
  repoPath: string,
): Promise<{ path: string; branch: string }[]> {
  const output = await execGit(["worktree", "list", "--porcelain"], repoPath);
  const worktrees: { path: string; branch: string }[] = [];
  let currentPath = "";
  let currentBranch = "";

  for (const line of output.split("\n")) {
    if (line.startsWith("worktree ")) {
      currentPath = line.slice("worktree ".length);
    } else if (line.startsWith("branch ")) {
      currentBranch = line.slice("branch ".length);
    } else if (line === "" && currentPath) {
      worktrees.push({ path: currentPath, branch: currentBranch });
      currentPath = "";
      currentBranch = "";
    }
  }
  if (currentPath) {
    worktrees.push({ path: currentPath, branch: currentBranch });
  }

  return worktrees;
}

/**
 * Create a git worktree for a branch. The worktree is created in a
 * `.worktrees/<branch>` directory sibling to the repo root.
 * If the branch doesn't exist yet, it is created from the given baseBranch
 * (or HEAD if no baseBranch is specified).
 * Throws if a worktree for this branch already exists.
 */
export async function createWorktree(
  repoPath: string,
  branch: string,
  baseBranch?: string,
): Promise<string> {
  // Check if a worktree for this branch already exists — reuse if healthy
  const existing = await listWorktrees(repoPath);
  const match = existing.find(
    (wt) => wt.branch === branch || wt.branch === `refs/heads/${branch}`,
  );
  if (match) {
    // Verify the branch still exists — merged/deleted branches leave prunable worktrees
    try {
      await execGit(["rev-parse", "--verify", branch], repoPath);
      // Branch exists — reuse the worktree
      return match.path.replace(/\//g, sep);
    } catch {
      // Branch gone (merged away) — prune stale worktree and recreate
      await execGit(["worktree", "remove", "--force", match.path], repoPath);
    }
  }

  // Sanitize branch name for directory use
  const safeName = branch.replace(/[^a-zA-Z0-9._-]/g, "_");
  const worktreesDir = join(dirname(repoPath), ".worktrees");
  const worktreePath = join(worktreesDir, safeName);

  await mkdir(worktreesDir, { recursive: true });

  // Check if branch exists; if not, create it from baseBranch (or HEAD)
  try {
    await execGit(["rev-parse", "--verify", branch], repoPath);
  } catch {
    const branchArgs = baseBranch ? ["branch", branch, baseBranch] : ["branch", branch];
    await execGit(branchArgs, repoPath);
  }

  await execGit(
    ["worktree", "add", worktreePath, branch],
    repoPath,
  );

  // Verify worktree is on the correct branch (not detached HEAD)
  await ensureOnBranch(worktreePath, branch);

  return worktreePath;
}

/** Remove a git worktree (force). */
export async function removeWorktree(
  repoPath: string,
  worktreePath: string,
): Promise<void> {
  await execGit(["worktree", "remove", "--force", worktreePath], repoPath);
}

/** Generate unified diff entries for untracked files (not yet git-add'd). */
async function getUntrackedDiffEntries(workdirPath: string): Promise<string> {
  const untrackedFiles = await execGit(["ls-files", "--others", "--exclude-standard"], workdirPath);
  if (!untrackedFiles.trim()) return "";

  const entries: string[] = [];
  for (const f of untrackedFiles.trim().split("\n").filter(Boolean)) {
    try {
      const content = await readFile(join(workdirPath, ...f.split("/")), "utf-8");
      const lines = content.split("\n");
      if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
      entries.push([
        `diff --git a/${f} b/${f}`,
        `new file mode 100644`,
        `--- /dev/null`,
        `+++ b/${f}`,
        `@@ -0,0 +1,${lines.length} @@`,
        ...lines.map((l) => `+${l}`),
      ].join("\n"));
    } catch {
      entries.push([
        `diff --git a/${f} b/${f}`,
        `new file mode 100644`,
        `--- /dev/null`,
        `+++ b/${f}`,
      ].join("\n"));
    }
  }
  return entries.join("\n");
}

/** Get a unified diff between the worktree's branch and a base branch, including untracked files. */
export async function getDiff(
  worktreePath: string,
  baseBranch: string = "main",
): Promise<string> {
  const tracked = await execGit(["diff", `${baseBranch}...HEAD`], worktreePath);
  const untracked = await getUntrackedDiffEntries(worktreePath);
  if (!untracked) return tracked;
  return tracked ? tracked + "\n" + untracked : untracked;
}

/** Get diff for a branch by name from the main repo (used when the worktree directory is gone). */
export async function getDiffFromRepo(
  repoPath: string,
  branch: string,
  baseBranch: string = "main",
): Promise<string> {
  return execGit(["diff", `${baseBranch}...${branch}`], repoPath);
}

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

/** Delete a local branch. */
export async function deleteBranch(
  repoPath: string,
  branch: string,
): Promise<void> {
  await execGit(["branch", "-d", branch], repoPath);
}

/** Merge a branch into the current HEAD of the repo. */
export async function mergeBranch(
  repoPath: string,
  branch: string,
): Promise<string> {
  return execGit(["merge", "--no-ff", branch, "-m", `Merge branch '${branch}'`], repoPath);
}

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

/** Get the current branch name of a repo. */
export async function getCurrentBranch(repoPath: string): Promise<string> {
  const output = await execGit(["rev-parse", "--abbrev-ref", "HEAD"], repoPath);
  return output.trim();
}

/** Get diff of working tree changes against HEAD (for direct workspaces), including untracked files. */
export async function getWorkingTreeDiff(workdirPath: string): Promise<string> {
  const tracked = await execGit(["diff", "HEAD"], workdirPath);
  const untracked = await getUntrackedDiffEntries(workdirPath);
  if (!untracked) return tracked;
  return tracked ? tracked + "\n" + untracked : untracked;
}

/**
 * Fetch the latest base branch and merge it into the current workspace branch.
 * Returns the diff ref to use for review (e.g., "origin/main" or "main").
 * If the merge fails (conflicts), returns success=false and the merge is aborted.
 */
export async function prepareForReview(
  worktreePath: string,
  baseBranch: string,
): Promise<{ diffRef: string; success: boolean; error?: string }> {
  // Try to fetch from origin (best effort — no remote is fine)
  let hasRemote = false;
  try {
    await execGit(["fetch", "origin", baseBranch], worktreePath);
    hasRemote = true;
  } catch {
    // No remote configured — use local branches only
  }

  // Determine merge source: prefer remote ref, fall back to local
  let mergeSource: string;
  if (hasRemote) {
    try {
      await execGit(["rev-parse", "--verify", `remotes/origin/${baseBranch}`], worktreePath);
      mergeSource = `origin/${baseBranch}`;
    } catch {
      mergeSource = baseBranch;
    }
  } else {
    mergeSource = baseBranch;
  }

  // Merge the base branch into the current workspace branch
  try {
    await execGit(["merge", mergeSource, "--no-edit"], worktreePath);
  } catch (err) {
    // Merge conflict or failure — abort and report
    try {
      await execGit(["merge", "--abort"], worktreePath);
    } catch { /* best effort */ }
    return { diffRef: mergeSource, success: false, error: err instanceof Error ? err.message : String(err) };
  }

  return { diffRef: mergeSource, success: true };
}

/** Get lightweight diff stats using --shortstat (no full diff transfer). Includes untracked files. */
export async function getDiffShortstat(
  worktreePath: string,
  baseBranch: string,
): Promise<{ filesChanged: number; insertions: number; deletions: number }> {
  try {
    // For direct workspaces (baseBranch="HEAD"), compare working tree against HEAD
    // For feature branches, use three-dot to show changes since branching
    const diffArgs = baseBranch === "HEAD"
      ? ["diff", "--shortstat", "HEAD"]
      : ["diff", "--shortstat", `${baseBranch}...HEAD`];
    const output = await execGit(diffArgs, worktreePath);

    let filesChanged = 0;
    let insertions = 0;
    let deletions = 0;

    if (output.trim()) {
      const filesMatch = output.match(/(\d+) files? changed/);
      if (filesMatch) filesChanged = parseInt(filesMatch[1], 10);

      const insertionsMatch = output.match(/(\d+) insertion/);
      if (insertionsMatch) insertions = parseInt(insertionsMatch[1], 10);

      const deletionsMatch = output.match(/(\d+) deletion/);
      if (deletionsMatch) deletions = parseInt(deletionsMatch[1], 10);
    }

    const untracked = await execGit(["ls-files", "--others", "--exclude-standard"], worktreePath);
    if (untracked.trim()) {
      const untrackedList = untracked.trim().split("\n").filter(Boolean);
      filesChanged += untrackedList.length;
      for (const f of untrackedList) {
        try {
          const content = await readFile(join(worktreePath, ...f.split("/")), "utf-8");
          const lineCount = content.split("\n").length - (content.endsWith("\n") ? 1 : 0);
          insertions += lineCount;
        } catch { /* binary or unreadable */ }
      }
    }

    return { filesChanged, insertions, deletions };
  } catch (err) {
    console.error(`[git] diff --shortstat failed in ${worktreePath}:`, err instanceof Error ? err.message : String(err));
    return { filesChanged: 0, insertions: 0, deletions: 0 };
  }
}

/**
 * Detect merge conflicts between the current branch and the base branch.
 * Uses git merge-tree (read-only, no working tree changes) — safe for concurrent calls.
 */
export async function detectConflicts(
  worktreePath: string,
  baseBranch: string,
): Promise<{ hasConflicts: boolean; conflictingFiles: string[] }> {
  return new Promise((resolve) => {
    // merge-tree exits 0 for clean merge, 1 for conflicts.
    // Stdout: tree SHA on line 1, then conflict entries (mode sha stage\tfile) for conflicting files.
    execFile(
      "git",
      ["merge-tree", "--write-tree", "--no-messages", "HEAD", baseBranch],
      { cwd: worktreePath, maxBuffer: 10 * 1024 * 1024 },
      (_err, stdout) => {
        const lines = stdout.toString().trim().split("\n").slice(1).filter(Boolean);
        // Lines with stage 1/2/3 indicate conflicting files: "<mode> <sha> <stage>\t<file>"
        const seen = new Set<string>();
        for (const line of lines) {
          const m = line.match(/^\d+ \w+ [123]\t(.+)$/);
          if (m) seen.add(m[1].replace(/\r$/, ""));
        }
        const conflictingFiles = [...seen];
        resolve({ hasConflicts: conflictingFiles.length > 0, conflictingFiles });
      },
    );
  });
}

/**
 * Rebase the current branch onto the latest base branch.
 * On conflict, returns conflicting files and leaves rebase in-progress for resolution.
 */
export async function rebaseOntoBase(
  worktreePath: string,
  baseBranch: string,
  branch?: string,
): Promise<{ success: boolean; conflictingFiles?: string[]; error?: string }> {
  try {
    await execGit(["fetch", "origin", baseBranch], worktreePath);
  } catch { /* no remote */ }

  let source = baseBranch;
  try {
    await execGit(["rev-parse", "--verify", `remotes/origin/${baseBranch}`], worktreePath);
    source = `origin/${baseBranch}`;
  } catch { /* use local */ }

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

/**
 * Merge the base branch into the current workspace branch.
 * On conflict, returns conflicting files and leaves merge in-progress for resolution.
 */
export async function mergeBaseIntoBranch(
  worktreePath: string,
  baseBranch: string,
): Promise<{ success: boolean; conflictingFiles?: string[]; error?: string }> {
  try {
    await execGit(["fetch", "origin", baseBranch], worktreePath);
  } catch { /* no remote */ }

  let source = baseBranch;
  try {
    await execGit(["rev-parse", "--verify", `remotes/origin/${baseBranch}`], worktreePath);
    source = `origin/${baseBranch}`;
  } catch { /* use local */ }

  try {
    await execGit(["merge", source, "--no-edit"], worktreePath);
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

/** Abort an in-progress merge. */
export async function abortMerge(worktreePath: string): Promise<void> {
  await execGit(["merge", "--abort"], worktreePath);
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
