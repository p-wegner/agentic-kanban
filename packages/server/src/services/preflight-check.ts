import { gitExecOrThrow } from "@agentic-kanban/shared/lib/git-exec";
import { existsSync, readFileSync } from "node:fs";
import { access, readFile } from "node:fs/promises";
import { join } from "node:path";
import { bootstrapSymlinks } from "@agentic-kanban/shared/lib/worktree-symlink-bootstrap";
import type { SymlinkBootstrapResult } from "@agentic-kanban/shared/lib/worktree-symlink-bootstrap";

export interface PreflightResult {
  ok: boolean;
  errors: string[];
}

const SAFETY_POLICY_FILES = [
  ".codex/hooks.json",
  ".claude/hooks/smart-hooks-runner.js",
  ".claude/hooks/validate-command-safety.js",
  ".claude/hooks/prevent-cross-worktree-writes.js",
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
  symlinkDirs?: string[];
  bootstrapSymlinks?: (sourceDir: string, worktreeDir: string, dirNames: string[]) => Promise<SymlinkBootstrapResult>;
}

export interface WorkspaceLaunchPreflightResult extends PreflightResult {
  staleFiles: string[];
  refreshed: boolean;
  dirtyFiles: string[];
  repairedSymlinks: string[];
}

function execGit(args: string[], cwd: string): Promise<string> {
  return gitExecOrThrow(args, { cwd });
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

/**
 * Files the branch's OWN commits modified (relative to baseBranch), via a three-dot diff
 * from the merge-base. These are intentional changes, not drift — the reconcile step must
 * never treat them as stale/needing a reset from base, or it will clobber the ticket's own
 * work (e.g. a ticket whose whole point is changing hook behavior).
 */
async function getBranchOwnedFiles(
  git: (args: string[], cwd: string) => Promise<string>,
  worktreePath: string,
  baseBranch: string,
): Promise<Set<SafetyPolicyFile>> {
  try {
    const output = await git(["diff", "--name-only", `${baseBranch}...HEAD`], worktreePath);
    return new Set(parsePorcelainFiles(output) as SafetyPolicyFile[]);
  } catch {
    return new Set();
  }
}

/** How many times a [preflight] reconcile commit already touched this file on this branch. */
async function countPriorReconcileCommits(
  git: (args: string[], cwd: string) => Promise<string>,
  worktreePath: string,
  file: SafetyPolicyFile,
): Promise<number> {
  try {
    const output = await git(
      ["log", "--oneline", "-E", "--grep=reconcile safety files.*\\[preflight\\]", "--", file],
      worktreePath,
    );
    return parsePorcelainFiles(output).length;
  } catch {
    return 0;
  }
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
    return { ok: true, errors: [], staleFiles: [], refreshed: false, dirtyFiles: [], repairedSymlinks: [] };
  }

  const readPolicyFile = options.readFile ?? defaultReadFile;
  const policyExists = options.exists ?? defaultExists;
  const git = options.execGit ?? execGit;
  const errors: string[] = [];
  const expectedBranch = options.branch.trim();
  const baseBranch = options.baseBranch?.trim();
  let dirtyFiles = parsePorcelainFiles(await git(["status", "--porcelain"], options.worktreePath));
  let repairedSymlinks: string[] = [];

  // Files the branch's own commits intentionally modified are never "stale drift" —
  // exclude them from every staleness check below so reconcile never clobbers them.
  const branchOwnedFiles = baseBranch
    ? await getBranchOwnedFiles(git, options.worktreePath, baseBranch)
    : new Set<SafetyPolicyFile>();

  if (expectedBranch) {
    const currentBranch = await getCurrentBranch(git, options.worktreePath);
    if (currentBranch !== expectedBranch) {
      if (dirtyFiles.length > 0) {
        errors.push(
          `Workspace is not attached to branch ${expectedBranch} and has uncommitted changes. ` +
            "checkpoint/commit the workspace first, then reattach the worktree before relaunching the agent.",
        );
        return { ok: false, errors, staleFiles: [], refreshed: false, dirtyFiles, repairedSymlinks };
      }

      try {
        await git(["checkout", expectedBranch], options.worktreePath);
      } catch (err) {
        errors.push(
          `Workspace is not attached to branch ${expectedBranch} and could not be reattached before launch. ` +
            `${err instanceof Error ? err.message : String(err)}`,
        );
        return { ok: false, errors, staleFiles: [], refreshed: false, dirtyFiles, repairedSymlinks };
      }
      dirtyFiles = parsePorcelainFiles(await git(["status", "--porcelain"], options.worktreePath));
    }
  }

  const staleBefore = (await findStaleSafetyFiles({
    repoPath: options.repoPath,
    worktreePath: options.worktreePath,
    readFile: readPolicyFile,
    exists: policyExists,
  })).filter((f) => !branchOwnedFiles.has(f));

  if (dirtyFiles.length > 0 && staleBefore.length > 0) {
    errors.push(
      `Workspace safety policy is stale (${staleBefore.join(", ")}) and the worktree has uncommitted changes. ` +
        "checkpoint/commit the workspace first, then update-base/rebase before relaunching the agent.",
    );
    return { ok: false, errors, staleFiles: staleBefore, refreshed: false, dirtyFiles, repairedSymlinks };
  }

  let refreshed = false;
  const symlinkDirs = options.symlinkDirs ?? [];
  if (symlinkDirs.length > 0) {
    const linkDeps = options.bootstrapSymlinks ?? bootstrapSymlinks;
    try {
      const symlinkResult = await linkDeps(options.repoPath, options.worktreePath, symlinkDirs);
      repairedSymlinks = symlinkResult.linked;
      if (symlinkResult.linked.length > 0) {
        refreshed = true;
        console.log(`[preflight] repaired worktree symlinks: ${symlinkResult.linked.join(", ")}`);
      }
      if (symlinkResult.failed.length > 0) {
        console.warn(`[preflight] worktree symlink repair skipped failures: ${symlinkResult.failed.map(f => `${f.dir}: ${f.error}`).join(", ")}`);
      }
    } catch (err) {
      console.warn(`[preflight] worktree symlink repair error (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
    }
  }

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
      return { ok: false, errors, staleFiles: staleBefore, refreshed, dirtyFiles, repairedSymlinks };
    }
  }

  if (expectedBranch) {
    const currentBranch = await getCurrentBranch(git, options.worktreePath);
    if (currentBranch !== expectedBranch) {
      errors.push(
        `Workspace is not attached to branch ${expectedBranch} after update-base. ` +
          "Do not launch the agent from a detached or wrong-branch worktree.",
      );
      return { ok: false, errors, staleFiles: staleBefore, refreshed, dirtyFiles, repairedSymlinks };
    }
  }

  const staleAfter = (await findStaleSafetyFiles({
    repoPath: options.repoPath,
    worktreePath: options.worktreePath,
    readFile: readPolicyFile,
    exists: policyExists,
  })).filter((f) => !branchOwnedFiles.has(f));

  if (staleAfter.length > 0 && dirtyFiles.length === 0 && baseBranch) {
    // Worktree is clean but safety files diverge from main (e.g. branch pre-dates a hooks
    // change). Pull each stale file directly from the base branch so the agent launches safely.
    // Files the branch's own commits touched were already excluded from staleAfter above.
    const reconciled: SafetyPolicyFile[] = [];
    const failed: SafetyPolicyFile[] = [];
    const pingPong: SafetyPolicyFile[] = [];
    for (const file of staleAfter) {
      const priorReconciles = await countPriorReconcileCommits(git, options.worktreePath, file);
      if (priorReconciles > 0) {
        // This exact file was already force-reset from base by a prior [preflight] reconcile
        // commit and has gone stale again — reconciling it again would silently loop
        // (reconcile/restore ping-pong). Abort loudly instead of repeating the reset.
        pingPong.push(file);
        continue;
      }
      try {
        await git(["checkout", baseBranch, "--", file], options.worktreePath);
        reconciled.push(file);
      } catch {
        failed.push(file);
      }
    }
    if (reconciled.length > 0) {
      try {
        await git(["commit", "-m", `chore: reconcile safety files from ${baseBranch} [preflight]`], options.worktreePath);
      } catch {
        // If commit fails the files are staged but not committed; still allow launch
        // since the policy content is now correct in the working tree.
      }
      console.log(`[preflight] reconciled safety files from ${baseBranch}: ${reconciled.join(", ")}`);
    }
    if (failed.length > 0) {
      errors.push(
        `Workspace safety policy is stale after update-base (${failed.join(", ")}) and could not be reconciled automatically. ` +
          "Refresh these files from the main checkout manually before relaunching.",
      );
    }
    if (pingPong.length > 0) {
      errors.push(
        `Workspace safety policy for ${pingPong.join(", ")} was already reconciled from ${baseBranch} once before ` +
          "and has gone stale again (reconcile/restore ping-pong). Refusing to reconcile it again automatically — " +
          "resolve manually: either keep this branch's change to the file, or drop the prior [preflight] reconcile commit.",
      );
    }
    return { ok: errors.length === 0, errors, staleFiles: [...failed, ...pingPong], refreshed: refreshed || reconciled.length > 0, dirtyFiles, repairedSymlinks };
  }

  if (staleAfter.length > 0) {
    errors.push(
      `Workspace safety policy is stale after update-base (${staleAfter.join(", ")}). ` +
        "Do not launch the agent from this worktree; checkpoint/commit first if dirty, then refresh it from the main checkout.",
    );
  }

  return { ok: errors.length === 0, errors, staleFiles: staleAfter, refreshed, dirtyFiles, repairedSymlinks };
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
