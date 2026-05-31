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

export function classifyProcessExit(code, signal) {
  if (signal === "SIGINT" || signal === "SIGTERM") return "clean";
  if (code === 0) return "clean";

  // The server child is `tsx watch src/index.ts`. tsx handles hot reloads inside
  // that watcher process, so this supervisor should only see an exit when the
  // watcher itself stopped. Keep code=1 fatal to avoid retry loops on startup
  // failures such as EADDRINUSE, migration errors, or syntax/load failures.
  if (code === 1) return "fatal";

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
