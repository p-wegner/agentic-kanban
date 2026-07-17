import { existsSync } from "node:fs";
import { join } from "node:path";
import { gitExecSync } from "@agentic-kanban/shared/lib/git-exec";
import { getCurrentBranch } from "@agentic-kanban/shared/lib/git-service";
import { takeScaffoldWrites } from "./scaffold-writes.js";

const SCAFFOLD_COMMIT_MESSAGE = "chore: scaffold agent guards and onboarding";

const DURABLE_CLAUDE_SCAFFOLD_PATHS = [
  ".claude/settings.json",
  ".claude/hooks/README.md",
  ".claude/hooks/smart-hooks-runner.js",
  ".claude/hooks/vital-file-guard.js",
  ".claude/hooks/vital-files.json",
  ".claude/hooks/prevent-cross-worktree-writes.js",
  ".claude/hooks/smart-hooks-config.json",
  ".claude/hooks/verify-gate-runner.js",
  ".claude/hooks/verify-gate.config.json",
  ".claude/smart-hooks-rules.json",
];

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
 * - no-op unless one of the scaffold paths changed in git status,
 * - commits only the scaffold paths by explicit message.
 */
export async function commitProjectScaffoldArtifacts(repoPath: string): Promise<void> {
  try {
    const branch = await getCurrentBranch(repoPath);
    if (branch === "HEAD") return;

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

    if (pathsToCommit.size === 0) return;
    const paths = [...pathsToCommit];
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
      return;
    } catch {
      gitExecSync(["commit", "-m", SCAFFOLD_COMMIT_MESSAGE, "--", ...paths], {
        cwd: repoPath,
        stdio: ["ignore", "ignore", "ignore"],
      });
    }
  } catch {
    /* non-fatal: registration must never fail because of scaffold commit */
  }
}
