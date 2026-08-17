import { existsSync } from "node:fs";
import { join } from "node:path";
import { gitExecOrThrow } from "../git-exec.js";

/** Run git via the sanctioned adapter, throwing on failure; returns trimmed stdout contract of gitExecOrThrow. */
export function execGit(args: string[], cwd: string): Promise<string> {
  return gitExecOrThrow(args, { cwd });
}

/**
 * Same, but never served from the read-dedupe memo (#621).
 *
 * Only for reads that must observe a mutation made by ANOTHER process — i.e. an agent
 * committing in its worktree — which adapter-driven invalidation cannot see and the memo's
 * ~1.5s TTL would otherwise hide. See the `fresh` option in git-exec.ts.
 */
export function execGitFresh(args: string[], cwd: string): Promise<string> {
  return gitExecOrThrow(args, { cwd, fresh: true });
}

/** Split git porcelain output into trimmed, non-empty lines (handles Windows CRLF). */
export function splitGitLines(out: string): string[] {
  return out
    .split("\n")
    .map((l) => l.replace(/\r$/, "").trim())
    .filter(Boolean);
}

/** Check if a directory is a valid git working tree (has .git file/dir). */
export function isGitWorkingTree(dir: string): boolean {
  try { return existsSync(join(dir, ".git")); } catch { return false; }
}
