import { execFile, execFileSync } from "node:child_process";
import { resolve, basename } from "node:path";

export interface RepoInfo {
  repoPath: string;
  repoName: string;
  defaultBranch: string | null;
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

export async function branchExists(repoPath: string, branch: string): Promise<boolean> {
  const normalized = branch.trim();
  if (!normalized || normalized.startsWith("-")) return false;

  try {
    await execGit(["show-ref", "--verify", "--quiet", `refs/heads/${normalized}`], repoPath);
    return true;
  } catch {
    return false;
  }
}

async function detectDefaultBranch(repoPath: string): Promise<string | null> {
  for (const branch of ["main", "master"]) {
    if (await branchExists(repoPath, branch)) return branch;
  }
  return null;
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

  const defaultBranch = await detectDefaultBranch(absPath);

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

export interface ProjectGitStats {
  commitCount: number;
  recentCommits: { hash: string; message: string; date: string }[];
  detectedBranch: string | null;
}

export function getProjectGitStats(repoPath: string, defaultBranch: string | null): ProjectGitStats {
  let commitCount = 0;
  let recentCommits: { hash: string; message: string; date: string }[] = [];

  // If defaultBranch is not stored in the DB, try to detect it synchronously
  let branch = defaultBranch;
  if (!branch) {
    for (const candidate of ["main", "master"]) {
      try {
        execFileSync("git", ["show-ref", "--verify", "--quiet", `refs/heads/${candidate}`], { cwd: repoPath, timeout: 2000 });
        branch = candidate;
        break;
      } catch { /* branch doesn't exist */ }
    }
  }

  if (!branch) return { commitCount, recentCommits, detectedBranch: null };

  try {
    const countOut = execFileSync("git", ["rev-list", "--count", branch], { cwd: repoPath, timeout: 5000 }).toString().trim();
    commitCount = parseInt(countOut, 10) || 0;
    // Use ASCII unit separator (\x1f) to avoid conflicts with commit message content
    const sep = "\x1f";
    const logOut = execFileSync("git", ["log", branch, `--format=%H${sep}%s${sep}%cr`, "-10"], { cwd: repoPath, timeout: 5000 }).toString().trim();
    recentCommits = logOut.split("\n").filter(Boolean).map((line) => {
      const parts = line.split(sep);
      return { hash: (parts[0] ?? "").slice(0, 7), message: parts[1] ?? "", date: parts[2] ?? "" };
    });
  } catch { /* git unavailable or no commits */ }
  return { commitCount, recentCommits, detectedBranch: branch };
}
