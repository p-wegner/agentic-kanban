import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { relative } from "node:path";
import { walkRepoTree } from "./lib/repo-tree.mjs";

const DEPENDENCY_MANIFEST_NAMES = new Set([
  "package.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
]);

// #1037: `.claude` is excluded because `<main>/.claude/worktrees/*` (Claude Code's nested
// EnterWorktree layout) carries its OWN package.json/pnpm-lock.yaml/pnpm-workspace.yaml.
// Scanning into it made an unrelated nested worktree's dependency churn look like a change
// to THIS checkout's own manifests — proven mechanism behind #1033's node_modules wipe:
// this checkout's already-running `pnpm dev` snapshots dependency manifests recursively;
// creating/using a nested worktree changes that recursive file SET (new package.json etc.
// appear under `.claude/worktrees/<name>`) even though nothing about THIS checkout's real
// dependencies changed. The next time any of this checkout's own dev child processes has an
// unrelated fatal exit after running healthily (e.g. the #117 vite ws-proxy crash), the
// supervisor sees "manifests changed" and self-triggers `pnpm install --frozen-lockfile` on
// THIS checkout while its own dev server still holds files open — an install that can abort
// mid-relink (Windows EPERM) between removing the stale top-level node_modules links and
// recreating them, leaving `.pnpm`/`.modules.yaml` intact but the top-level links gone. That
// is exactly the #1033 signature, and it requires no `--force`, no junction between the
// trees, and no command ever run with a nested worktree as cwd — reproduced and pinned by
// `packages/server/src/__tests__/dev-script.test.mjs`.
//
// #1241: the skip set is no longer kept here. `walkRepoTree` (scripts/lib/repo-tree.mjs)
// carries the canonical set (`.git`, `.turbo`, `.vite`, `build`, `dist`, `node_modules`,
// `target`, …), hides every dot-directory by default (which covers `.claude`), skips any
// directory whose `.git` is a FILE (a nested linked worktree under ANY name, not only under
// `.claude/worktrees`) and never follows a junction.

// A child that stayed up this long is considered to have started successfully,
// so a later exit is a crash under load rather than a startup failure.
export const HEALTHY_UPTIME_MS = 10_000;

export function classifyProcessExit(code, signal, context = {}) {
  if (signal === "SIGINT" || signal === "SIGTERM") return "clean";
  if (code === 0) return "clean";

  if (code === 1) {
    // Startup failures (EADDRINUSE, migration errors, syntax/load failures)
    // reproduce on every attempt, so retrying them just loops — keep those fatal.
    // But a child that served healthily and *then* exited 1 crashed under load
    // (#117: vite's ws-proxy hitting ECONNABORTED during a burst of board
    // events). That is transient, and refusing to restart it is what turned a
    // client-side hiccup into a permanently dead half of the dev stack.
    return context.uptimeMs >= HEALTHY_UPTIME_MS ? "retry" : "fatal";
  }

  return "retry";
}

function hashFile(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

export function listDependencyManifestFiles(rootDir) {
  if (!existsSync(rootDir)) return [];
  return walkRepoTree(rootDir, { filter: (_abs, entry) => DEPENDENCY_MANIFEST_NAMES.has(entry.name) }).sort();
}

export function snapshotDependencyManifests(rootDir) {
  return new Map(
    listDependencyManifestFiles(rootDir).map((file) => [
      relative(rootDir, file).replace(/\\/g, "/"),
      hashFile(file),
    ]),
  );
}

export function dependencyManifestsChanged(before, after) {
  if (before.size !== after.size) return true;
  for (const [path, hash] of before) {
    if (after.get(path) !== hash) return true;
  }
  return false;
}

export function createDependencyRecoveryState(initialSnapshot) {
  let snapshot = initialSnapshot;
  let generation = 0;

  return {
    get snapshot() {
      return snapshot;
    },
    get generation() {
      return generation;
    },
    markRecovered(nextSnapshot) {
      snapshot = nextSnapshot;
      generation++;
      return generation;
    },
  };
}

// Matches ERR_MODULE_NOT_FOUND errors that reference packages/shared/dist.
// The server child emits these to stderr before exiting with code 1 when the
// shared package has not been built (or is stale after a merge).
const STALE_SHARED_DIST_RE = /Cannot find (?:module|package) '.*packages[/\\]shared[/\\]dist/;

export function isStaleSharedDistError(output) {
  return STALE_SHARED_DIST_RE.test(output);
}

export const MAX_SHARED_DIST_REBUILDS = 2;

export function createSharedDistRecoveryState() {
  let rebuilds = 0;

  return {
    get rebuilds() {
      return rebuilds;
    },
    canRebuild() {
      return rebuilds < MAX_SHARED_DIST_REBUILDS;
    },
    markRebuilt() {
      rebuilds++;
      return rebuilds;
    },
  };
}
