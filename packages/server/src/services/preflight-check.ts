import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface PreflightResult {
  ok: boolean;
  errors: string[];
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
