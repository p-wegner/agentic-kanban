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

export async function createWorktree(repoPath: string, branch: string, baseBranch?: string): Promise<string> {
  // Check if a worktree for this branch already exists
  const existing = await listWorktrees(repoPath);
  const match = existing.find(
    (wt) => wt.branch === branch || wt.branch === `refs/heads/${branch}`,
  );
  if (match) {
    throw new Error(
      `A worktree for branch '${branch}' already exists at: ${match.path}`,
    );
  }

  const safeName = branch.replace(/[^a-zA-Z0-9._-]/g, "_");
  const worktreesDir = join(dirname(repoPath), ".worktrees");
  const worktreePath = join(worktreesDir, safeName);

  await mkdir(worktreesDir, { recursive: true });

  try {
    await execGit(["rev-parse", "--verify", branch], repoPath);
  } catch {
    const branchArgs = baseBranch ? ["branch", branch, baseBranch] : ["branch", branch];
    await execGit(branchArgs, repoPath);
  }

  await execGit(["worktree", "add", worktreePath, branch], repoPath);
  return worktreePath;
}

export async function getDiff(worktreePath: string, baseBranch: string = "main"): Promise<string> {
  return execGit(["diff", baseBranch], worktreePath);
}

export async function removeWorktree(repoPath: string, worktreePath: string): Promise<void> {
  await execGit(["worktree", "remove", "--force", worktreePath], repoPath);
}
