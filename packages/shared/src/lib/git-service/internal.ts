import { existsSync } from "node:fs";
import { join } from "node:path";
import { gitExecOrThrow } from "../git-exec.js";

/** Run git via the sanctioned adapter, throwing on failure; returns trimmed stdout contract of gitExecOrThrow. */
export function execGit(args: string[], cwd: string): Promise<string> {
  return gitExecOrThrow(args, { cwd });
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
