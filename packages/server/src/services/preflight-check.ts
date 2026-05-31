import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { access, readFile } from "node:fs/promises";
import { join } from "node:path";

export interface PreflightResult {
  ok: boolean;
  errors: string[];
}

const SAFETY_POLICY_FILES = [
  ".codex/hooks.json",
  ".claude/hooks/smart-hooks-runner.js",
  ".claude/hooks/validate-command-safety.js",
  "CLAUDE.md",
] as const;

type SafetyPolicyFile = typeof SAFETY_POLICY_FILES[number];

interface WorkspaceLaunchPreflightOptions {
  repoPath: string;
  worktreePath: string;
  baseBranch: string | null | undefined;
  branch: string;
  isDirect: boolean;
  execGit?: (args: string[], cwd: string) => Promise<string>;
  readFile?: (root: string, relativePath: string) => Promise<string>;
  exists?: (root: string, relativePath: string) => Promise<boolean>;
}

export interface WorkspaceLaunchPreflightResult extends PreflightResult {
  staleFiles: string[];
  refreshed: boolean;
  dirtyFiles: string[];
}

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

async function defaultExists(root: string, relativePath: string): Promise<boolean> {
  try {
    await access(join(root, ...relativePath.split("/")));
    return true;
  } catch {
    return false;
  }
}

async function defaultReadFile(root: string, relativePath: string): Promise<string> {
  return readFile(join(root, ...relativePath.split("/")), "utf-8");
}

function normalizePolicyText(text: string): string {
  return text.replace(/\r\n/g, "\n");
}

async function findStaleSafetyFiles(opts: Required<Pick<WorkspaceLaunchPreflightOptions, "repoPath" | "worktreePath" | "readFile" | "exists">>): Promise<SafetyPolicyFile[]> {
  const stale: SafetyPolicyFile[] = [];
  for (const relativePath of SAFETY_POLICY_FILES) {
    const mainExists = await opts.exists(opts.repoPath, relativePath);
    const worktreeExists = await opts.exists(opts.worktreePath, relativePath);
    if (mainExists !== worktreeExists) {
      stale.push(relativePath);
      continue;
    }
    if (!mainExists) continue;
    const [mainText, worktreeText] = await Promise.all([
      opts.readFile(opts.repoPath, relativePath),
      opts.readFile(opts.worktreePath, relativePath),
    ]);
    if (normalizePolicyText(mainText) !== normalizePolicyText(worktreeText)) {
      stale.push(relativePath);
    }
  }
  return stale;
}

function parsePorcelainFiles(output: string): string[] {
  return output
    .split("\n")
    .map((line) => line.replace(/\r$/, ""))
    .filter(Boolean);
}

async function getCurrentBranch(
  git: (args: string[], cwd: string) => Promise<string>,
  cwd: string,
): Promise<string | null> {
  try {
    const branch = (await git(["rev-parse", "--abbrev-ref", "HEAD"], cwd)).trim();
    return branch && branch !== "HEAD" ? branch : null;
  } catch {
    return null;
  }
}

/**
 * Deterministic guard before launching/resuming an agent in a worktree.
 *
 * Safety hook/policy files are compared against the main checkout. Clean worktrees
 * are rebased onto the current base branch before launch; dirty worktrees with
 * stale safety policy are refused so the orchestrator checkpoints first.
 */
export async function workspaceLaunchPreflight(
  options: WorkspaceLaunchPreflightOptions,
): Promise<WorkspaceLaunchPreflightResult> {
  if (options.isDirect) {
    return { ok: true, errors: [], staleFiles: [], refreshed: false, dirtyFiles: [] };
  }

  const readPolicyFile = options.readFile ?? defaultReadFile;
  const policyExists = options.exists ?? defaultExists;
  const git = options.execGit ?? execGit;
  const errors: string[] = [];
  const expectedBranch = options.branch.trim();
  let dirtyFiles = parsePorcelainFiles(await git(["status", "--porcelain"], options.worktreePath));

  if (expectedBranch) {
    const currentBranch = await getCurrentBranch(git, options.worktreePath);
    if (currentBranch !== expectedBranch) {
      if (dirtyFiles.length > 0) {
        errors.push(
          `Workspace is not attached to branch ${expectedBranch} and has uncommitted changes. ` +
            "checkpoint/commit the workspace first, then reattach the worktree before relaunching the agent.",
        );
        return { ok: false, errors, staleFiles: [], refreshed: false, dirtyFiles };
      }

      try {
        await git(["checkout", expectedBranch], options.worktreePath);
      } catch (err) {
        errors.push(
          `Workspace is not attached to branch ${expectedBranch} and could not be reattached before launch. ` +
            `${err instanceof Error ? err.message : String(err)}`,
        );
        return { ok: false, errors, staleFiles: [], refreshed: false, dirtyFiles };
      }
      dirtyFiles = parsePorcelainFiles(await git(["status", "--porcelain"], options.worktreePath));
    }
  }

  const staleBefore = await findStaleSafetyFiles({
    repoPath: options.repoPath,
    worktreePath: options.worktreePath,
    readFile: readPolicyFile,
    exists: policyExists,
  });

  if (dirtyFiles.length > 0 && staleBefore.length > 0) {
    errors.push(
      `Workspace safety policy is stale (${staleBefore.join(", ")}) and the worktree has uncommitted changes. ` +
        "checkpoint/commit the workspace first, then update-base/rebase before relaunching the agent.",
    );
    return { ok: false, errors, staleFiles: staleBefore, refreshed: false, dirtyFiles };
  }

  let refreshed = false;
  const baseBranch = options.baseBranch?.trim();
  if (dirtyFiles.length === 0 && baseBranch) {
    try {
      await git(["fetch", "origin", baseBranch], options.worktreePath).catch(() => "");
      await git(["rebase", baseBranch], options.worktreePath);
      refreshed = true;
    } catch (err) {
      try { await git(["rebase", "--abort"], options.worktreePath); } catch { /* best effort */ }
      errors.push(
        `Workspace update-base preflight failed before agent launch. ` +
          `Checkpoint/commit if needed, then resolve the rebase manually. ${err instanceof Error ? err.message : String(err)}`,
      );
      return { ok: false, errors, staleFiles: staleBefore, refreshed, dirtyFiles };
    }
  }

  if (expectedBranch) {
    const currentBranch = await getCurrentBranch(git, options.worktreePath);
    if (currentBranch !== expectedBranch) {
      errors.push(
        `Workspace is not attached to branch ${expectedBranch} after update-base. ` +
          "Do not launch the agent from a detached or wrong-branch worktree.",
      );
      return { ok: false, errors, staleFiles: staleBefore, refreshed, dirtyFiles };
    }
  }

  const staleAfter = await findStaleSafetyFiles({
    repoPath: options.repoPath,
    worktreePath: options.worktreePath,
    readFile: readPolicyFile,
    exists: policyExists,
  });
  if (staleAfter.length > 0) {
    errors.push(
      `Workspace safety policy is stale after update-base (${staleAfter.join(", ")}). ` +
        "Do not launch the agent from this worktree; checkpoint/commit first if dirty, then refresh it from the main checkout.",
    );
  }

  return { ok: errors.length === 0, errors, staleFiles: staleAfter, refreshed, dirtyFiles };
}

/**
 * Run preflight health checks before launching an agent in a worktree.
 * Catches environment issues that would waste an entire agent session.
 */
export function preflightCheck(
  worktreePath: string,
  isDirect: boolean,
): PreflightResult {
  const errors: string[] = [];

  // 1. Worktree directory exists
  if (!existsSync(worktreePath)) {
    errors.push(`Worktree directory does not exist: ${worktreePath}`);
    return { ok: false, errors };
  }

  // 2. .git file/link exists in the worktree (skip for direct workspaces — they use the main checkout)
  if (!isDirect) {
    const gitPath = join(worktreePath, ".git");
    if (!existsSync(gitPath)) {
      errors.push(`Worktree .git not found at ${gitPath} — the worktree may be corrupted or deleted`);
    } else {
      // Verify the .git file is readable (worktrees have a .git file pointing to the main repo)
      try {
        readFileSync(gitPath, "utf8");
      } catch {
        errors.push(`Worktree .git at ${gitPath} is not readable — check file permissions`);
      }
    }
  }

  // 3. KANBAN_SERVER_PORT is set (agent needs it to talk back to the board)
  const serverPort = process.env.KANBAN_SERVER_PORT || process.env.PORT;
  if (!serverPort) {
    errors.push("KANBAN_SERVER_PORT / PORT environment variable not set — agent won't be able to reach the board API");
  }

  // 4. KANBAN_CLIENT_PORT is set (agent needs it for visual verification URLs)
  const clientPort = process.env.KANBAN_CLIENT_PORT || process.env.VITE_PORT;
  if (!clientPort) {
    errors.push("KANBAN_CLIENT_PORT / VITE_PORT environment variable not set — visual verification URLs will be wrong");
  }

  return { ok: errors.length === 0, errors };
}
