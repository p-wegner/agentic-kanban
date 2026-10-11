// #1402: a shim written before #1400 has no version check and no versions/current.json, so it still
// falls back to the global install that another board's `npm i -g` may have replaced. On the next
// start the worker copies its own install into its versions dir and points current.json at the copy,
// so later global installs no longer change what the shim runs. Db-free: part of the standalone worker.

import { cpSync, existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { parseBuildId } from "../lib/worker-update.js";
import { shimDirFor } from "./worker-shim.js";
import { entryForBuild, readPointer, versionsDirFor, writePointer } from "./worker-versions.js";

/** True when the resolver on disk predates #1400 (it carries no baked fallback version). */
export function hasLegacyShim(stateFile: string): boolean {
  try {
    const src = readFileSync(join(shimDirFor(stateFile), "worker-shim.cjs"), "utf8");
    return !src.includes("fallbackVersion");
  } catch {
    return false; // no shim yet — the new one is written pinned-aware
  }
}

/** Package root (`.../agentic-kanban`) of a `bin/worker.js` entry, with its version; null if unreadable. */
function packageOf(entry: string): { root: string; version: string } | null {
  const root = resolve(dirname(entry), "..");
  try {
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { name?: string; version?: string };
    return pkg.name === "agentic-kanban" && pkg.version ? { root, version: pkg.version } : null;
  } catch {
    return null;
  }
}

/**
 * Pin the running install for an old-style shim. Returns the build id pinned, or null when nothing
 * was done (shim not legacy, already pinned, running from the versions dir, or no build id). Best
 * effort — a failure never blocks a start.
 */
export function repinLegacyShim(stateFile: string, runningEntry: string | null): string | null {
  try {
    if (!runningEntry || !hasLegacyShim(stateFile)) return null;
    const dir = versionsDirFor(stateFile);
    if (readPointer(dir)) return null;
    if (resolve(runningEntry).startsWith(resolve(dir) + sep)) return null;
    const pkg = packageOf(runningEntry);
    const buildId = pkg ? parseBuildId(pkg.version) : undefined;
    if (!pkg || !buildId) return null;
    const entry = entryForBuild(dir, buildId);
    if (!existsSync(entry)) {
      // npm nests a global install's dependencies inside the package, so the copy is self-contained.
      cpSync(pkg.root, dirname(dirname(entry)),{ recursive: true });
    }
    if (!existsSync(entry)) return null;
    writePointer(dir, { buildId, entry });
    return buildId;
  } catch {
    return null;
  }
}
