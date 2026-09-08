import { existsSync } from "node:fs";
import { join } from "node:path";
import { gitExecSync } from "@agentic-kanban/shared/lib/git-exec";
import { getHeadState } from "@agentic-kanban/shared/lib/git-service";
import { takeScaffoldWrites } from "./scaffold-writes.js";

const SCAFFOLD_COMMIT_MESSAGE = "chore: scaffold agent guards and onboarding";

export const DURABLE_CLAUDE_SCAFFOLD_PATHS = [
  ".claude/settings.json",
  ".claude/hooks/README.md",
  ".claude/hooks/smart-hooks-runner.js",
  ".claude/hooks/vital-file-guard.js",
  ".claude/hooks/vital-files.json",
  ".claude/hooks/prevent-cross-worktree-writes.js",
  // Hard load-time dependency of smart-hooks-runner.js (#392/#279). It was written by the
  // scaffold but MISSING from this list, so registration left it untracked and the main
  // checkout went dirty from registration onward — the exact #38 `dirty_main` shape this
  // commit exists to prevent, reintroduced by a hook that was added without touching this
  // hand-maintained list. `scaffold-commit-covers-hooks.test.ts` now ties the two together.
  ".claude/hooks/git-topology-cache.js",
  // #913 — the runner's posture/capacity policy modules. Same reason as the topology cache
  // above: written by the scaffold, so untracked here means a dirty checkout from
  // registration onward.
  ".claude/hooks/hook-posture.js",
  ".claude/hooks/machine-capacity.js",
  ".claude/hooks/smart-hooks-config.json",
  ".claude/hooks/verify-gate-runner.js",
  ".claude/hooks/verify-gate.config.json",
  ".claude/hooks/disclose-context.mjs",
  // .claude/smart-hooks-rules.json is deliberately ABSENT: it is machine-regenerated
  // per checkout and gitignored (ca79487c). Force-committing it here put a volatile
  // file on master AND every branch, which made every merge conflict on it.
  // Written by the compounding "setup once" pass (#127). Committed for the same reason as
  // the rest: a builder only inherits it if it is on the branch its worktree forks from.
  ".claude/domain-map.md",
];

export interface ScaffoldCommitResult {
  /** Whether a commit was actually made. */
  committed: boolean;
  /**
   * Why nothing was committed. `"disabled"` = `scaffold_auto_commit` is off, writes are left
   * in the working tree; `"no-changes"` = none of the scaffold paths were dirty; `"error"` =
   * git failed (see the `catch` below — non-fatal, registration must not block on it).
   */
  reason?: "disabled" | "no-changes" | "detached" | "error";
  /** Scaffold paths that were (or, when disabled, would have been) committed. */
  paths: string[];
}

function readGitIdentity(repoPath: string): string | null {
  try {
    const name = gitExecSync(["config", "user.name"], { cwd: repoPath, stdio: ["ignore", "pipe", "ignore"] }).trim();
    const email = gitExecSync(["config", "user.email"], { cwd: repoPath, stdio: ["ignore", "pipe", "ignore"] }).trim();
    if (!name && !email) return null;
    return `${name} <${email}>`;
  } catch {
    return null;
  }
}

function statusLineToPath(line: string): string {
  const raw = line.slice(3).trim();
  if (!raw) return "";
  const arrow = raw.indexOf(" -> ");
  return arrow >= 0 ? raw.slice(arrow + 4) : raw;
}

function isScaffoldTrackedPath(pathName: string): boolean {
  if (pathName === ".gitignore" || pathName === "CLAUDE.md" || pathName === "AGENTS.md") return true;
  return pathName === ".claude" || pathName.startsWith(".claude/");
}

/**
 * Commit board-authored scaffold files in the main checkout so future workspace
 * worktrees fork from a clean main branch and auto-merge does not fail on dirty_main.
 *
 * Behavior:
 * - non-fatal on all failures (registration must not block),
 * - no-op on detached HEAD (explicitly skip),
 * - commits normally on an unborn branch (a repo's first commit is a normal commit),
 * - no-op unless one of the scaffold paths changed in git status,
 * - commits only the scaffold paths by explicit message.
 *
 * `autoCommit: false` (the `scaffold_auto_commit` preference, #1082) leaves the scaffold
 * writes sitting in the working tree instead of committing them — the caller is expected to
 * have already read that preference, since this module has no DB access of its own. Either
 * way the outcome is logged (`[scaffold]`), because a silent commit under whatever ambient
 * `git config user.*` happens to be set is what let a prior scaffold regression (#1070) land
 * in history unnoticed instead of sitting visibly dirty in the working tree.
 */
export async function commitProjectScaffoldArtifacts(
  repoPath: string,
  options?: { autoCommit?: boolean },
): Promise<ScaffoldCommitResult> {
  const autoCommit = options?.autoCommit ?? true;
  try {
    const head = await getHeadState(repoPath);
    if (head.kind === "detached") return { committed: false, reason: "detached", paths: [] };

    const status = gitExecSync(["status", "--porcelain", "--untracked-files=all"], {
      cwd: repoPath,
      stdio: ["ignore", "pipe", "ignore"],
    });

    const pathsToCommit = new Set<string>();
    for (const line of status.split("\n")) {
      const pathName = statusLineToPath(line);
      if (!isScaffoldTrackedPath(pathName)) continue;

      if (pathName === ".gitignore") pathsToCommit.add(".gitignore");
      if (pathName === "CLAUDE.md") pathsToCommit.add("CLAUDE.md");
      if (pathName === "AGENTS.md") pathsToCommit.add("AGENTS.md");
    }

    for (const pathName of DURABLE_CLAUDE_SCAFFOLD_PATHS) {
      if (existsSync(join(repoPath, ...pathName.split("/")))) pathsToCommit.add(pathName);
    }

    // Files ensureBuildableFromClean rewrote this run (package.json / pnpm-workspace.yaml).
    // Without this the board's own edit is left uncommitted and the main checkout is dirty
    // from registration onward, which blocks every merge with `dirty_main` (#38).
    for (const pathName of takeScaffoldWrites(repoPath)) {
      if (existsSync(join(repoPath, pathName))) pathsToCommit.add(pathName);
    }

    if (pathsToCommit.size === 0) return { committed: false, reason: "no-changes", paths: [] };
    const paths = [...pathsToCommit];

    if (!autoCommit) {
      console.log(
        `[scaffold] scaffold_auto_commit is off — ${paths.length} scaffold path(s) left uncommitted in ${repoPath}: ${paths.join(", ")}`,
      );
      return { committed: false, reason: "disabled", paths };
    }

    const regularPaths = paths.filter((pathName) => !pathName.startsWith(".claude/"));
    const claudePaths = paths.filter((pathName) => pathName.startsWith(".claude/"));

    if (regularPaths.length > 0) {
      gitExecSync(["add", "-A", "--", ...regularPaths], {
        cwd: repoPath,
        stdio: ["ignore", "ignore", "ignore"],
      });
    }
    if (claudePaths.length > 0) {
      gitExecSync(["add", "-f", "--", ...claudePaths], {
        cwd: repoPath,
        stdio: ["ignore", "ignore", "ignore"],
      });
    }

    try {
      gitExecSync(["diff", "--cached", "--quiet", "--", ...paths], {
        cwd: repoPath,
        stdio: ["ignore", "ignore", "ignore"],
      });
      return { committed: false, reason: "no-changes", paths: [] };
    } catch {
      gitExecSync(["commit", "-m", SCAFFOLD_COMMIT_MESSAGE, "--", ...paths], {
        cwd: repoPath,
        stdio: ["ignore", "ignore", "ignore"],
      });
      const identity = readGitIdentity(repoPath);
      console.log(
        `[scaffold] committed ${paths.length} scaffold path(s) in ${repoPath} as ${identity ?? "unknown git identity"}: ${paths.join(", ")}`,
      );
      return { committed: true, paths };
    }
  } catch {
    /* non-fatal: registration must never fail because of scaffold commit */
    return { committed: false, reason: "error", paths: [] };
  }
}
