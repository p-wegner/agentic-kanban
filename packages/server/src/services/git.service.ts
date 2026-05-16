import { execFile } from "node:child_process";
import { mkdir } from "node:fs/promises";
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

  return worktreePath;
}

/** Remove a git worktree (force). */
export async function removeWorktree(
  repoPath: string,
  worktreePath: string,
): Promise<void> {
  await execGit(["worktree", "remove", "--force", worktreePath], repoPath);
}

/** Get a unified diff between the worktree's branch and a base branch. */
export async function getDiff(
  worktreePath: string,
  baseBranch: string = "main",
): Promise<string> {
  return execGit(["diff", baseBranch], worktreePath);
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

/** Merge a branch into the current HEAD of the repo. */
export async function mergeBranch(
  repoPath: string,
  branch: string,
): Promise<string> {
  return execGit(["merge", "--no-ff", branch, "-m", `Merge branch '${branch}'`], repoPath);
}

/** Get the current branch name of a repo. */
export async function getCurrentBranch(repoPath: string): Promise<string> {
  const output = await execGit(["rev-parse", "--abbrev-ref", "HEAD"], repoPath);
  return output.trim();
}

/** Get diff of working tree changes against HEAD (for direct workspaces). */
export async function getWorkingTreeDiff(workdirPath: string): Promise<string> {
  const tracked = await execGit(["diff", "HEAD"], workdirPath);
  const untrackedFiles = await execGit(["ls-files", "--others", "--exclude-standard"], workdirPath);
  if (!untrackedFiles.trim()) return tracked;
  const header = tracked ? tracked + "\n" : "";
  return header + untrackedFiles.trim().split("\n").filter(Boolean).map(f =>
    `diff --git a/${f} b/${f}\nnew file mode 100644`
  ).join("\n");
}

/** Get lightweight diff stats using --shortstat (no full diff transfer). */
export async function getDiffShortstat(
  worktreePath: string,
  baseBranch: string,
): Promise<{ filesChanged: number; insertions: number; deletions: number }> {
  try {
    const output = await execGit(["diff", "--shortstat", baseBranch], worktreePath);
    if (!output.trim()) return { filesChanged: 0, insertions: 0, deletions: 0 };

    let filesChanged = 0;
    let insertions = 0;
    let deletions = 0;

    const filesMatch = output.match(/(\d+) files? changed/);
    if (filesMatch) filesChanged = parseInt(filesMatch[1], 10);

    const insertionsMatch = output.match(/(\d+) insertion/);
    if (insertionsMatch) insertions = parseInt(insertionsMatch[1], 10);

    const deletionsMatch = output.match(/(\d+) deletion/);
    if (deletionsMatch) deletions = parseInt(deletionsMatch[1], 10);

    return { filesChanged, insertions, deletions };
  } catch (err) {
    console.error(`[git] diff --shortstat failed in ${worktreePath}:`, err instanceof Error ? err.message : String(err));
    return { filesChanged: 0, insertions: 0, deletions: 0 };
  }
}
