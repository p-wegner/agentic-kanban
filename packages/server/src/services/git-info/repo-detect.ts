/**
 * Repo DETECTION — "what repository is at this path, and what is its default branch".
 *
 * Stateless, cheap, and on the hot path: project registration, the projects route and
 * the plugin output-location resolver all call `detectRepoInfo` while a user waits. It
 * used to share a file with the project-stats engine, whose 15-second `git log` scans
 * and HEAD-keyed cache have nothing in common with it beyond the word "git" — that half
 * now lives in `git-info/project-stats.ts` (#728); `git-info.service.ts` is now a
 * facade re-exporting both, so no importer changed.
 */

import { resolve, dirname, basename } from "node:path";
import { gitExecOrThrow } from "@agentic-kanban/shared/lib/git-exec";

export interface RepoInfo {
  repoPath: string;
  repoName: string;
  defaultBranch: string | null;
  remoteUrl: string | null;
}

function execGit(args: string[], cwd: string): Promise<string> {
  return gitExecOrThrow(args, { cwd, maxBuffer: 1024 * 1024 }).then((stdout) => stdout.trim());
}

/** Async git exec with a timeout, mirroring the sync gitExecSync call options. Output is NOT trimmed. */
function execGitCapture(args: string[], cwd: string, timeout: number, maxBuffer = 1024 * 1024): Promise<string> {
  return gitExecOrThrow(args, { cwd, timeout, maxBuffer });
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

export async function detectDefaultBranch(repoPath: string): Promise<string | null> {
  for (const branch of ["main", "master"]) {
    if (await branchExists(repoPath, branch)) return branch;
  }
  return null;
}

/**
 * A LINKED worktree's `--git-dir` (`<main>/.git/worktrees/<name>`) differs from its
 * `--git-common-dir` (the shared `<main>/.git`); a main checkout's / a bare repo's own
 * worktree's two resolve to the same directory (#1104). This is what `git worktree list`
 * later enumerates by REPO, not by project, so registering a linked worktree's own
 * toplevel (which `--show-toplevel` happily returns) as a project's `repoPath` makes
 * every sibling worktree of that shared repo look like it belongs to this one project.
 *
 * Returns the main checkout's path when `gitRoot` is a linked worktree, `null` otherwise
 * (including when the probe itself fails — fail OPEN here, since refusing every
 * registration on a git hiccup is worse than occasionally missing this specific check).
 */
async function detectLinkedWorktreeMainCheckout(gitRoot: string): Promise<string | null> {
  try {
    const [gitDir, commonDir] = await Promise.all([
      execGit(["rev-parse", "--path-format=absolute", "--git-dir"], gitRoot),
      execGit(["rev-parse", "--path-format=absolute", "--git-common-dir"], gitRoot),
    ]);
    if (resolve(gitDir) === resolve(commonDir)) return null;
    return resolve(dirname(resolve(commonDir)));
  } catch {
    return null;
  }
}

/**
 * Detect git repo information from a local path.
 * Validates the path is a git repo and extracts branch/remote info.
 * Always resolves to the git repository root, so registering from a subdirectory
 * (e.g. packages/server) produces the same project as registering from the root.
 */
export async function detectRepoInfo(repoPath: string): Promise<RepoInfo> {
  const absPath = resolve(repoPath);

  // Resolve to the actual git root — prevents duplicate projects when a subdirectory
  // (e.g. packages/server) and the repo root both get registered separately.
  // Use resolve() to normalize the path (git outputs forward slashes on Windows).
  let gitRoot: string;
  try {
    gitRoot = resolve(await execGit(["rev-parse", "--show-toplevel"], absPath));
  } catch {
    throw new Error(`Not a git repository: ${absPath}`);
  }

  // #1104: `--show-toplevel` inside a LINKED worktree returns the worktree's own
  // directory, so nothing above this would ever notice it isn't a main checkout. A
  // worktree shares its underlying repo with every sibling worktree, so registering
  // it as a project made `orphaned-worktree-reconciler`'s `git worktree list` (scoped
  // by repoPath) sweep every sibling worktree of the shared repo as if it belonged to
  // this one project. Refuse outright — the fix is to register the main checkout.
  const mainCheckoutPath = await detectLinkedWorktreeMainCheckout(gitRoot);
  if (mainCheckoutPath) {
    throw new Error(
      `${gitRoot} is a linked git worktree, not a main checkout — it shares its repository with ` +
        `every other worktree of ${mainCheckoutPath}. Register ${mainCheckoutPath} instead.`,
    );
  }

  const defaultBranch = await detectDefaultBranch(gitRoot);

  // Get remote URL
  let remoteUrl: string | null = null;
  try {
    remoteUrl = await execGit(["remote", "get-url", "origin"], gitRoot);
  } catch {
    // No remote configured
  }

  const repoName = basename(gitRoot);

  return {
    repoPath: gitRoot,
    repoName,
    defaultBranch,
    remoteUrl,
  };
}
