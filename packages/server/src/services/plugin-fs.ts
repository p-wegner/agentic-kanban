/**
 * Filesystem and manifest helpers for the plugin service — extracted from `plugin.service.ts`
 * when it crossed the 1000-line god-module ceiling and blocked every merge on the board.
 *
 * These are deliberately PURE module-level functions (no service closure, no injected deps): a
 * manifest read, a path-containment check, a `.git/info/exclude` append, and symlink/junction
 * probing. Keeping them free of the service's `deps` is what makes them safe to lift out and
 * testable on their own.
 */
import { existsSync, readFileSync, appendFileSync, mkdirSync, statSync, lstatSync, unlinkSync, rmdirSync } from "node:fs";
import { join, resolve, sep, dirname } from "node:path";
import { homedir } from "node:os";
import { PLUGIN_MANIFEST_FILENAME, parsePluginManifest, type PluginManifest } from "@agentic-kanban/shared/lib/plugin-manifest";
import { PluginError } from "./plugin-errors.js";

/** Where cloned plugins live. Overridable so tests never touch a real plugin store. */
export function pluginsHomeDir(): string {
  return process.env.AGENTIC_KANBAN_PLUGINS_DIR || join(homedir(), ".agentic-kanban", "plugins");
}

/** True for a source string that should be treated as a git remote rather than a local path. */
export function looksLikeGitUrl(source: string): boolean {
  return /^(https?:\/\/|git@|ssh:\/\/|git:\/\/)/.test(source);
}

/**
 * Read and parse a plugin manifest from `dir`.
 *
 * Parse failures are re-tagged as {@link PluginError} `BAD_REQUEST` so the route layer answers
 * 400 rather than 500 — a malformed manifest is the caller's input, not a server fault.
 */
export function readManifestFromDir(dir: string): { manifest: PluginManifest; raw: string } {
  const manifestPath = join(dir, PLUGIN_MANIFEST_FILENAME);
  if (!existsSync(manifestPath)) {
    throw new PluginError(`No ${PLUGIN_MANIFEST_FILENAME} found at ${dir}`, "BAD_REQUEST");
  }
  const raw = readFileSync(manifestPath, "utf8");
  try {
    return { manifest: parsePluginManifest(raw), raw };
  } catch (err) {
    throw new PluginError(err instanceof Error ? err.message : String(err), "BAD_REQUEST");
  }
}

/** Resolve a manifest-relative path inside `root`, refusing escapes (defense in depth). */
export function resolveInside(root: string, relativePath: string, what: string): string {
  const rootAbs = resolve(root);
  const target = resolve(rootAbs, relativePath);
  if (target !== rootAbs && !target.startsWith(rootAbs + sep)) {
    throw new PluginError(`${what} escapes its root: ${relativePath}`, "BAD_REQUEST");
  }
  return target;
}

/** Idempotently append a line to `<repo>/.git/info/exclude` (skips worktree .git files). */
export function addToGitInfoExclude(repoPath: string, line: string): void {
  const gitDir = join(repoPath, ".git");
  try {
    if (!existsSync(gitDir) || !statSync(gitDir).isDirectory()) return;
    const excludePath = join(gitDir, "info", "exclude");
    mkdirSync(dirname(excludePath), { recursive: true });
    const existing = existsSync(excludePath) ? readFileSync(excludePath, "utf8") : "";
    if (existing.split(/\r?\n/).includes(line)) return;
    appendFileSync(excludePath, (existing.endsWith("\n") || existing === "" ? "" : "\n") + line + "\n");
  } catch {
    /* exclude bookkeeping is best-effort */
  }
}

/** True when the path exists and is a symlink/junction (never a real dir). */
export function isLinkPath(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

/** Remove a symlink/junction, falling back to rmdir semantics for Windows directory junctions. */
export function removeLink(path: string): void {
  try {
    unlinkSync(path);
  } catch {
    rmdirSync(path);
  }
}
