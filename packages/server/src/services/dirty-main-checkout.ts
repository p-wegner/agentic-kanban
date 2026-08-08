import { existsSync } from "node:fs";
import { gitExecOrThrow } from "@agentic-kanban/shared/lib/git-exec";
import type { Database } from "../db/index.js";
import { db } from "../db/index.js";
import { getAllProjects, setProjectArchived } from "../repositories/project.repository.js";

/**
 * After this many CONSECUTIVE missing-repo-path detections a project is auto-archived (#271).
 * The warning used to name the fix ("Unregister the project or fix its repoPath") and then
 * nothing performed it, so the monitor re-discovered the same dead path every cycle forever —
 * scanning + spawning git for repos that cannot make progress, concurrently with real merges.
 * Archiving removes the project from every default project listing (and thus from monitor
 * scheduling) while staying fully reversible: fix the path, unarchive, done.
 *
 * In-memory on purpose: a restart resets the count, which only delays the archive by a few
 * scan cycles. A repo that comes back resets its count immediately.
 */
const MISSING_REPO_ARCHIVE_THRESHOLD = 3;
const consecutiveMissingScans = new Map<string, number>();

/** Test seam. */
export function resetMissingRepoScanCounts(): void {
  consecutiveMissingScans.clear();
}

const SOURCE_PATHSPECS = [
  ":(glob)packages/**/*.ts",
  ":(glob)packages/**/*.tsx",
  ":(glob)packages/**/*.sql",
];

export interface DirtyMainCheckoutWarning {
  projectId: string;
  projectName: string;
  repoPath: string;
  detectedAt: string;
  fileCount: number;
  files: string[];
  message: string;
}

export async function getDirtyTrackedSourceFiles(repoPath: string): Promise<string[]> {
  const stdout = await gitExecOrThrow(
    ["diff", "--name-only", "HEAD", "--", ...SOURCE_PATHSPECS],
    { cwd: repoPath, timeout: 5000, maxBuffer: 1024 * 1024 },
  );
  return stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

export async function scanDirtyMainCheckouts(database: Database = db): Promise<DirtyMainCheckoutWarning[]> {
  const projectRows = await getAllProjects(database, { includeArchived: true });
  const detectedAt = new Date().toISOString();
  const warnings: DirtyMainCheckoutWarning[] = [];

  for (const project of projectRows) {
    if (!project.repoPath) continue;
    // #208: a project whose repo directory no longer exists on disk (moved/deleted worktree,
    // stale registration) surfaces as `spawn git ENOENT` from a missing cwd — repeatedly, every
    // cycle, forever. Skip the spawn entirely and surface it as a warning instead.
    if (!existsSync(project.repoPath)) {
      // An archived project with a dead path is already resolved — no warning churn (#271).
      if (project.archivedAt) continue;
      const misses = (consecutiveMissingScans.get(project.id) ?? 0) + 1;
      consecutiveMissingScans.set(project.id, misses);
      if (misses >= MISSING_REPO_ARCHIVE_THRESHOLD) {
        try {
          await setProjectArchived(project.id, true, database);
          consecutiveMissingScans.delete(project.id);
          console.warn(
            `[dirty-main-checkout] auto-archived project "${project.name}" (${project.id}) — repoPath missing for ${MISSING_REPO_ARCHIVE_THRESHOLD} consecutive scans: ${project.repoPath}. Unarchive it after fixing the path.`,
          );
          warnings.push({
            projectId: project.id,
            projectName: project.name,
            repoPath: project.repoPath,
            detectedAt,
            fileCount: 0,
            files: [],
            message: `Repo path missing for ${MISSING_REPO_ARCHIVE_THRESHOLD} consecutive scans — project auto-archived (#271). Unarchive it after fixing the path.`,
          });
        } catch (err) {
          console.warn(`[dirty-main-checkout] failed to auto-archive project ${project.id} (non-fatal):`, err instanceof Error ? err.message : String(err));
        }
        continue;
      }
      warnings.push({
        projectId: project.id,
        projectName: project.name,
        repoPath: project.repoPath,
        detectedAt,
        fileCount: 0,
        files: [],
        message: `Repo path no longer exists on disk — skipping dirty-checkout scan (${misses}/${MISSING_REPO_ARCHIVE_THRESHOLD} before auto-archive). Unregister the project or fix its repoPath.`,
      });
      continue;
    }
    consecutiveMissingScans.delete(project.id);
    let files: string[];
    try {
      files = await getDirtyTrackedSourceFiles(project.repoPath);
    } catch (err) {
      console.warn(`[dirty-main-checkout] failed to inspect ${project.repoPath}:`, err instanceof Error ? err.message : String(err));
      continue;
    }
    // Hand the event loop back between repos (#349). This scan is purely diagnostic but walks
    // ~20 registered repos with a `git diff` each; without a yield the whole walk is one
    // uninterrupted macrotask chain competing with every request, WS broadcast and SSE stream.
    await new Promise<void>((resolve) => setImmediate(resolve));
    if (files.length === 0) continue;

    const preview = files.slice(0, 5).join(", ");
    const more = files.length > 5 ? ` (and ${files.length - 5} more)` : "";
    warnings.push({
      projectId: project.id,
      projectName: project.name,
      repoPath: project.repoPath,
      detectedAt,
      fileCount: files.length,
      files,
      message: `Main checkout has ${files.length} uncommitted tracked source change(s): ${preview}${more}. Commit or revert them before relying on monitor/merge automation.`,
    });
  }

  return warnings;
}
