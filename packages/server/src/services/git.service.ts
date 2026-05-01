import { execFile } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { join, dirname } from "node:path";

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
 * Create a git worktree for a branch. The worktree is created in a
 * `.worktrees/<branch>` directory sibling to the repo root.
 * If the branch doesn't exist yet, it is created from HEAD.
 */
export async function createWorktree(
  repoPath: string,
  branch: string,
): Promise<string> {
  // Sanitize branch name for directory use
  const safeName = branch.replace(/[^a-zA-Z0-9._-]/g, "_");
  const worktreesDir = join(dirname(repoPath), ".worktrees");
  const worktreePath = join(worktreesDir, safeName);

  await mkdir(worktreesDir, { recursive: true });

  // Check if branch exists; if not, create it
  try {
    await execGit(["rev-parse", "--verify", branch], repoPath);
  } catch {
    await execGit(["branch", branch], repoPath);
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

/** Merge a branch into the current HEAD of the repo. */
export async function mergeBranch(
  repoPath: string,
  branch: string,
): Promise<string> {
  return execGit(["merge", "--no-ff", branch, "-m", `Merge branch '${branch}'`], repoPath);
}
