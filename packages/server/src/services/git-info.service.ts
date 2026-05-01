import { execFile } from "node:child_process";
import { resolve, basename } from "node:path";

export interface RepoInfo {
  repoPath: string;
  repoName: string;
  defaultBranch: string;
  remoteUrl: string | null;
}

function execGit(args: string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("git", args, { cwd, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        reject(new Error(`git ${args.join(" ")} failed: ${stderr || err.message}`));
      } else {
        resolve(stdout.toString().trim());
      }
    });
  });
}

/**
 * Detect git repo information from a local path.
 * Validates the path is a git repo and extracts branch/remote info.
 */
export async function detectRepoInfo(repoPath: string): Promise<RepoInfo> {
  const absPath = resolve(repoPath);

  // Validate it's a git repo
  try {
    await execGit(["rev-parse", "--git-dir"], absPath);
  } catch {
    throw new Error(`Not a git repository: ${absPath}`);
  }

  // Get default branch
  let defaultBranch = "main";
  try {
    const ref = await execGit(["symbolic-ref", "refs/remotes/origin/HEAD"], absPath);
    // Output is like "refs/remotes/origin/main"
    defaultBranch = ref.replace("refs/remotes/origin/", "");
  } catch {
    try {
      defaultBranch = await execGit(["config", "init.defaultBranch"], absPath);
    } catch {
      // Keep "main" as fallback
    }
  }

  // Get remote URL
  let remoteUrl: string | null = null;
  try {
    remoteUrl = await execGit(["remote", "get-url", "origin"], absPath);
  } catch {
    // No remote configured
  }

  const repoName = basename(absPath);

  return {
    repoPath: absPath,
    repoName,
    defaultBranch,
    remoteUrl,
  };
}
