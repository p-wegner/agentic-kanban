// Detect whether a registered project IS the board's own checkout (agentic-kanban).
//
// The dev-server port math (3001+N/5173+N per worktree) is this app's PRIVATE
// convention — it is correct only for the board's own worktrees. Every other project
// the board drives (a docker-compose stack, a multi-repo app, a Rails service) binds
// whatever ports ITS dev server chooses, so applying our convention to it fabricates a
// wrong port (ticket #100). This helper lets the diagnostics resolver decide when the
// worktree-port fallback is legitimate.
//
// "Self" = the project whose repoPath is the checkout the server process runs from.
// The rest of the codebase already treats `process.cwd()` as the checkout root
// (startup-tasks.ts, data-dir resolution), so we anchor to it here too, injectable
// for tests.

import { resolve } from "node:path";

/** Normalise a path for case/slash/trailing-slash-insensitive comparison. */
function normalizeRepoPath(p: string): string {
  return resolve(p).replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

/**
 * True when `repoPath` is the board's own checkout — i.e. the agentic-kanban project
 * that follows this app's worktree-port convention. `selfRoot` defaults to the server
 * process's working directory (the checkout it was launched from).
 */
export function isSelfProjectRepo(repoPath: string | null | undefined, selfRoot: string = process.cwd()): boolean {
  if (!repoPath) return false;
  return normalizeRepoPath(repoPath) === normalizeRepoPath(selfRoot);
}
