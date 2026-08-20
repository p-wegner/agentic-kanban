import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";

const DEPENDENCY_MANIFEST_NAMES = new Set([
  "package.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
]);

const IGNORED_DIRS = new Set([
  ".git",
  ".turbo",
  ".vite",
  "build",
  "dist",
  "node_modules",
  "target",
]);

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
  const files = [];

  function visit(dir) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (!IGNORED_DIRS.has(entry.name)) visit(join(dir, entry.name));
        continue;
      }

      if (entry.isFile() && DEPENDENCY_MANIFEST_NAMES.has(entry.name)) {
        files.push(join(dir, entry.name));
      }
    }
  }

  if (existsSync(rootDir)) visit(rootDir);
  return files.sort();
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
