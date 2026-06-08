import { lstat, mkdir, readdir, symlink, unlink } from "node:fs/promises";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve, relative, sep } from "node:path";

export type SymlinkBootstrapResult = {
  /** Directory names that were successfully linked. */
  linked: string[];
  /** Directory names that were skipped (already exist in worktree or not found in source). */
  skipped: string[];
  /** Directory names that failed to link, with error messages. */
  failed: Array<{ dir: string; error: string }>;
};

/**
 * Validate that a directory name is safe to symlink — no path traversal, no absolute paths.
 */
export function isValidDirName(name: string): boolean {
  if (!name || name.includes(sep) || name.includes("/")) return false;
  if (name === "." || name === "..") return false;
  // Reject names that resolve outside their parent (path traversal)
  const resolved = resolve("dummy", name);
  if (relative("dummy", resolved) !== name) return false;
  return true;
}

/**
 * Parse the symlinkDirs JSON from the database column.
 * Returns a validated array of directory names.
 */
export function parseSymlinkDirs(raw: string | null | undefined): string[] {
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return parsed.filter(
    (item): item is string => typeof item === "string" && isValidDirName(item),
  );
}

/**
 * For a pnpm/yarn/npm WORKSPACE monorepo, the root `node_modules` does not hold
 * the packages' dependencies under a strict linker (`shamefully-hoist=false`);
 * each workspace package has its OWN `node_modules` whose relative symlinks point
 * back up to the root `.pnpm` store. So junctioning only the root is useless —
 * `vitest`/`react`/etc. resolve from `packages/<pkg>/node_modules`. This expands
 * a request for "node_modules" into the per-package node_modules that also exist
 * in the source, so the whole workspace resolves inside the worktree.
 *
 * Returns RELATIVE paths (may contain separators), e.g.
 *   ["packages/server/node_modules", "packages/shared/node_modules"].
 * Returns [] when the source is not a workspace.
 */
export function discoverWorkspaceNodeModules(sourceDir: string): string[] {
  const resolvedSource = resolve(sourceDir);
  const wsFile = join(resolvedSource, "pnpm-workspace.yaml");
  if (!existsSync(wsFile)) return [];
  // Parse the simple `packages:\n  - "packages/*"` shape without a YAML dep.
  let patterns: string[] = [];
  try {
    const text = readFileSync(wsFile, "utf8");
    patterns = text
      .split(/\r?\n/)
      .map((l: string) => l.match(/^\s*-\s*["']?([^"'#]+?)["']?\s*$/))
      .filter((m): m is RegExpMatchArray => Boolean(m))
      .map((m) => m[1].trim());
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const pattern of patterns) {
    if (pattern.includes("..") || pattern.startsWith("/") || /^[A-Za-z]:/.test(pattern)) continue;
    if (pattern.endsWith("/*")) {
      const baseRel = pattern.slice(0, -2);
      const baseAbs = join(resolvedSource, baseRel);
      let children: string[] = [];
      try { children = readdirSync(baseAbs, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name); } catch { continue; }
      for (const child of children) {
        const rel = `${baseRel}/${child}/node_modules`.replace(/\\/g, "/");
        if (existsSync(join(resolvedSource, rel))) out.push(rel);
      }
    } else {
      const rel = `${pattern}/node_modules`.replace(/\\/g, "/");
      if (existsSync(join(resolvedSource, rel))) out.push(rel);
    }
  }
  return out;
}

/** A relative path is safe to link iff it resolves strictly inside `root`. */
function isContained(root: string, relPath: string): boolean {
  const rel = relative(root, resolve(root, relPath));
  return rel !== "" && !rel.startsWith("..") && !resolve(root, relPath).startsWith("..") && !relPath.includes("..");
}

/**
 * Link a single RELATIVE path (may be nested, e.g. "packages/server/node_modules")
 * from source into the worktree, creating parent dirs as needed. Same skip/never-
 * overwrite/broken-link-recreate semantics as the top-level case.
 */
async function linkOne(
  resolvedSource: string,
  resolvedWorktree: string,
  relPath: string,
  result: SymlinkBootstrapResult,
): Promise<void> {
  if (!isContained(resolvedSource, relPath) || !isContained(resolvedWorktree, relPath)) {
    result.failed.push({ dir: relPath, error: "Path escapes the source or worktree root" });
    return;
  }
  const sourcePath = join(resolvedSource, relPath);
  const targetPath = join(resolvedWorktree, relPath);

  try {
    const sourceStat = await lstat(sourcePath);
    if (!sourceStat.isDirectory()) { result.skipped.push(relPath); return; }
  } catch {
    result.skipped.push(relPath); return;
  }

  let targetExists = false;
  let targetIsSymlink = false;
  try {
    const targetStat = await lstat(targetPath);
    targetExists = true;
    targetIsSymlink = targetStat.isSymbolicLink();
  } catch { /* not present — proceed */ }

  if (targetExists && !targetIsSymlink) { result.skipped.push(relPath); return; }
  if (targetExists && targetIsSymlink) {
    try { await readdir(targetPath); result.skipped.push(relPath); return; }
    catch {
      try { await unlink(targetPath); }
      catch { result.failed.push({ dir: relPath, error: "Failed to remove broken existing symlink" }); return; }
    }
  }

  try {
    // Create any parent directory the nested path needs (e.g. worktree/packages/server).
    const parent = join(targetPath, "..");
    await mkdir(parent, { recursive: true });
    const type = process.platform === "win32" ? "junction" : "dir";
    const linkTarget = process.platform === "win32"
      ? sourcePath
      : relative(join(targetPath, ".."), sourcePath) || ".";
    await symlink(linkTarget, targetPath, type);
    result.linked.push(relPath);
  } catch (err) {
    result.failed.push({ dir: relPath, error: err instanceof Error ? err.message : String(err) });
  }
}

/**
 * Create symlinks/junctions from the source checkout into the worktree for
 * the given directory names. Workspace-aware: a request for "node_modules" in a
 * pnpm-workspace source ALSO links each `packages/<pkg>/node_modules`, because a
 * strict linker keeps deps per-package, not in the root (see
 * discoverWorkspaceNodeModules).
 *
 * Safety guarantees:
 * - Only links validated top-level names (no traversal) plus computed in-tree
 *   workspace paths (containment-checked).
 * - Skips if the target already exists in the worktree (never overwrites).
 * - Skips if the source directory doesn't exist in the main checkout.
 * - Does not mutate any worktree outside the target paths.
 * - On Windows, uses junctions (directory symlinks) instead of symlinks.
 *
 * @param sourceDir  The main checkout root (repoPath).
 * @param worktreeDir The worktree root where links are created.
 * @param dirNames   Validated directory names to symlink (e.g. ["node_modules", ".venv"]).
 */
export async function bootstrapSymlinks(
  sourceDir: string,
  worktreeDir: string,
  dirNames: string[],
): Promise<SymlinkBootstrapResult> {
  const result: SymlinkBootstrapResult = { linked: [], skipped: [], failed: [] };
  if (!dirNames.length) return result;

  const resolvedSource = resolve(sourceDir);
  const resolvedWorktree = resolve(worktreeDir);

  // Build the full list of relative paths to link. Top-level requested names
  // first; if node_modules is requested, expand to per-package node_modules too.
  const relPaths: string[] = [];
  for (const dirName of dirNames) {
    if (!isValidDirName(dirName)) { result.failed.push({ dir: dirName, error: "Invalid directory name" }); continue; }
    relPaths.push(dirName);
    if (dirName === "node_modules") {
      for (const wsRel of discoverWorkspaceNodeModules(resolvedSource)) {
        if (!relPaths.includes(wsRel)) relPaths.push(wsRel);
      }
    }
  }

  for (const relPath of relPaths) {
    await linkOne(resolvedSource, resolvedWorktree, relPath, result);
  }

  return result;
}
