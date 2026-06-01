import { lstat, mkdir, readdir, symlink, unlink } from "node:fs/promises";
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
 * Create symlinks/junctions from the source checkout into the worktree for
 * the given directory names.
 *
 * Safety guarantees:
 * - Only creates links for validated directory names (no path traversal).
 * - Skips if the target already exists in the worktree (never overwrites).
 * - Skips if the source directory doesn't exist in the main checkout.
 * - Does not mutate any worktree outside the target path.
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

  // Resolve both to absolute paths to prevent relative-path trickery
  const resolvedSource = resolve(sourceDir);
  const resolvedWorktree = resolve(worktreeDir);

  if (!dirNames.length) return result;

  for (const dirName of dirNames) {
    const sourcePath = join(resolvedSource, dirName);
    const targetPath = join(resolvedWorktree, dirName);

    // Check source exists and is a directory
    let sourceStat;
    try {
      sourceStat = await lstat(sourcePath);
      if (!sourceStat.isDirectory()) {
        result.skipped.push(dirName);
        continue;
      }
    } catch {
      // Source directory doesn't exist — skip silently
      result.skipped.push(dirName);
      continue;
    }

    // Check if target already exists
    let targetExists = false;
    let targetIsSymlink = false;
    try {
      const targetStat = await lstat(targetPath);
      targetExists = true;
      targetIsSymlink = targetStat.isSymbolicLink();
    } catch {
      // Target doesn't exist — proceed
    }

    if (targetExists && !targetIsSymlink) {
      // Real directory or file already exists — don't overwrite
      result.skipped.push(dirName);
      continue;
    }

    if (targetExists && targetIsSymlink) {
      // Existing symlink — check if it points to the right place
      // On Windows, junctions report as directories through stat but as
      // symlinks through lstat. If it's a working symlink, leave it.
      try {
        // Try accessing the target of the symlink
        await readdir(targetPath);
        result.skipped.push(dirName);
        continue;
      } catch {
        // Broken symlink — remove it so we can recreate
        try {
          await unlink(targetPath);
        } catch {
          result.failed.push({ dir: dirName, error: "Failed to remove broken existing symlink" });
          continue;
        }
      }
    }

    // Create the symlink/junction
    try {
      const type = process.platform === "win32" ? "junction" : "dir";
      const linkTarget = process.platform === "win32"
        ? sourcePath  // Junctions need absolute paths on Windows
        : relative(resolvedWorktree, sourcePath) || ".";  // Symlinks prefer relative
      await symlink(linkTarget, targetPath, type);
      result.linked.push(dirName);
    } catch (err) {
      result.failed.push({
        dir: dirName,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return result;
}
