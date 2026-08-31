// One Windows-safe path-equality helper (#532).
//
// "Are these two paths the same?" was re-answered by at least eight drifting
// recipes across the server, shared and client — resolve+lowercase; resolve+strip
// trailing separator+lowercase; resolve+forward-slash+strip+lowercase in two
// different orders; slash-normalise+lowercase with no resolve. They disagree on
// three axes (trailing separator, separator direction, whether `resolve` runs at
// all), so two callers could reach opposite verdicts about the same pair — and the
// answers gate real actions: is this the board's own checkout, is that worktree
// registered, does a sibling repo already hold this branch.
//
// They also ALL lower-cased unconditionally, which is wrong off Windows: on POSIX
// `/srv/Repo` and `/srv/repo` are different directories, and folding them together
// is a silent false positive. `pathKey` case-folds only on win32.
//
// Node-only (imports `node:path`); import via the deep path
// `@agentic-kanban/shared/lib/path-key`, never the client-reachable barrel.
// `normalizeSlashes` is the platform-free half the client can use.

import { resolve } from "node:path";

/**
 * Forward-slash a path without resolving it. Platform-free and safe anywhere,
 * including the browser — use this when you only need display/compare-shaped
 * text and cannot resolve against a real filesystem.
 */
export function normalizeSlashes(p: string): string {
  return p.replace(/\\/g, "/");
}

/** Strip trailing separators, but never turn a root ("/" or "C:/") into "". */
function stripTrailingSeparators(p: string): string {
  const stripped = p.replace(/[\\/]+$/, "");
  return stripped === "" || /^[A-Za-z]:$/.test(stripped) ? p.replace(/[\\/]+$/, "/") : stripped;
}

/**
 * A canonical comparison key for a filesystem path: absolute, forward-slashed,
 * no trailing separator, and case-folded ONLY on Windows.
 *
 * Not for display and not for passing to git or a shell — use the original path
 * for those. This is purely an equality key.
 */
export function pathKey(p: string): string {
  const canonical = stripTrailingSeparators(normalizeSlashes(resolve(p)));
  return process.platform === "win32" ? canonical.toLowerCase() : canonical;
}

/** Whether two paths denote the same location, per `pathKey`. */
export function samePath(a: string, b: string): boolean {
  return pathKey(a) === pathKey(b);
}

/**
 * Whether `child` is `parent` or lives underneath it. Compares on canonical keys,
 * and requires a separator at the boundary so `/srv/repo-2` is not treated as a
 * child of `/srv/repo`.
 */
export function isPathInside(child: string, parent: string): boolean {
  const c = pathKey(child);
  const p = pathKey(parent);
  if (c === p) return true;
  return c.startsWith(p.endsWith("/") ? p : p + "/");
}

/**
 * Re-root `p` from under `fromPrefix` to under `toPrefix`, preserving the SEPARATOR
 * STYLE of the original string (#964).
 *
 * Returns `null` when `p` is not inside `fromPrefix` — callers use that to decide
 * whether a row participates in a relocation at all, so "not affected" and "rewritten
 * to itself" stay distinguishable.
 *
 * The separator care matters: `workspaces.workingDir` and `repos.path` hold
 * Windows-style backslash paths written by `join()`, and a rewrite that quietly
 * forward-slashes them would still compare equal under `pathKey` but would no longer
 * match the raw string comparisons and log lines an operator reads.
 */
export function rewritePathPrefix(p: string, fromPrefix: string, toPrefix: string): string | null {
  if (!isPathInside(p, fromPrefix)) return null;
  const usesBackslash = p.includes("\\");
  const suffix = normalizeSlashes(resolve(p)).slice(stripTrailingSeparators(normalizeSlashes(resolve(fromPrefix))).length);
  const rebased = stripTrailingSeparators(normalizeSlashes(resolve(toPrefix))) + suffix;
  return usesBackslash ? rebased.replace(/\//g, "\\") : rebased;
}
