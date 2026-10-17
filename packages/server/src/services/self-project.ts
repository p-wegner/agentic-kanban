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

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathKey } from "@agentic-kanban/shared/lib/path-key";

/** Canonical comparison key for a repo path (#532 — one definition, win32-only case-fold). */
function normalizeRepoPath(p: string): string {
  return pathKey(p);
}

/**
 * True when `repoPath` is the board's own checkout — i.e. the agentic-kanban project
 * that follows this app's worktree-port convention. `selfRoot` defaults to the server
 * process's working directory (the checkout it was launched from).
 */
/**
 * The checkout root the server process runs from — NOT `process.cwd()` verbatim (#1010).
 *
 * The dev backend is spawned with `cwd: packages/server` (`scripts/server-dev-proxy.mjs`), so a
 * raw `process.cwd()` compared against a project's `repoPath` (the checkout ROOT) never matched:
 * the board's own project was never "self" on a running dev server, and every consumer that
 * asks — the docs+config guards-only gate run (#1008), the worktree-port convention — silently
 * took the foreign-project path (#999's diff ran the full suite despite #1008). Walk up from the
 * start dir to the nearest ancestor that looks like this monorepo's root (`pnpm-workspace.yaml`
 * beside `packages/server`); fall back to the start dir itself when nothing above qualifies, so
 * a packaged install (no self repo at all) behaves exactly as before.
 */
export function resolveSelfRoot(startDir: string = process.cwd()): string {
  let dir = startDir;
  for (let depth = 0; depth < 6; depth++) {
    if (existsSync(join(dir, "pnpm-workspace.yaml")) && existsSync(join(dir, "packages", "server"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return startDir;
}

export function isSelfProjectRepo(repoPath: string | null | undefined, selfRoot: string = resolveSelfRoot()): boolean {
  if (!repoPath) return false;
  return normalizeRepoPath(repoPath) === normalizeRepoPath(selfRoot);
}

/** What `scripts/test-mine.mjs` must contain to count as honouring a suite scope. */
const RETRY_SCOPE_MARKER = "KANBAN_RETRY_TEST_FILES";

/** A verify_script that runs the repo's own runner (`pnpm test:mine`, `node scripts/test-mine.mjs`). */
const RUNS_TEST_MINE = /\btest[:-]mine\b/;

/**
 * Does this project's verify_script honour `KANBAN_RETRY_TEST_FILES`, i.e. may the gate re-run only
 * the failing suites instead of the whole chain?
 *
 * `isSelfProjectRepo` alone answered that for the board's OWN checkout and nothing else. A board
 * that does not run from the project's checkout (the stable board driving this repo, a worker
 * run, a merge train) is never "self", so every retry was refused as "does not honour suite
 * scoping" and two load flakes condemned a whole train (#1579). The runner is what honours the
 * scope, so ask the runner: the script must invoke `test:mine` AND a checkout it runs in must carry
 * a `scripts/test-mine.mjs` that reads the variable. Anything else (gradlew, pytest) stays false.
 */
export function verifyHonoursSuiteScope(input: {
  repoPath?: string | null;
  workingDir?: string | null;
  verifyScript?: string | null;
  selfRoot?: string;
  readRunner?: (dir: string) => string | null;
}): boolean {
  if (isSelfProjectRepo(input.repoPath, input.selfRoot)) return true;
  if (!input.verifyScript || !RUNS_TEST_MINE.test(input.verifyScript)) return false;
  const readRunner =
    input.readRunner ??
    ((dir: string) => {
      try {
        return readFileSync(join(dir, "scripts", "test-mine.mjs"), "utf8");
      } catch {
        return null;
      }
    });
  return [input.workingDir, input.repoPath].some((dir) => {
    if (!dir) return false;
    return readRunner(dir)?.includes(RETRY_SCOPE_MARKER) === true;
  });
}
