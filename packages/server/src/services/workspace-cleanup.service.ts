/**
 * Workspace teardown & cleanup operations, extracted from workspace-crud.service.ts.
 *
 * This owns the destructive side of a workspace's lifecycle — stopping/killing its
 * agent sessions, removing its worktree + feature branch, and the stale-worktree /
 * cleanup-warning maintenance surface the cleanup UI drives. The crud service keeps
 * the create/delete/close orchestration and delegates the teardown primitives here,
 * passing the same injected deps (so gitService stays substitutable in tests).
 *
 * Every removal step is best-effort and never throws — a stray Windows file handle
 * or a half-pruned worktree must not crash the caller.
 */

import { existsSync } from "node:fs";
import { resolve as pathResolve, dirname, parse as pathParse, relative, sep } from "node:path";
import type { Database } from "../db/index.js";
import type { SessionManager } from "./session.manager.js";
import { kill as killAgent } from "./agent.service.js";
import { teardownWorktree, killProcessTree, removeDirWithRetry } from "./workspace-teardown.service.js";
import { resolveProjectRepo, getWorkspaceById } from "../repositories/workspace.repository.js";
import * as crudRepo from "../repositories/workspace-crud.repository.js";
import type { GitService } from "./workspace-internals.js";
import { cleanupSiblingWorktrees } from "./workspace-repos.service.js";

export interface StaleWorktreeEntry {
  id: string;
  branch: string;
  workingDir: string;
  workspaceStatus: string;
  closedAt: string | null;
  mergedAt: string | null;
  updatedAt: string | null;
  issueId: string;
  issueNumber: number;
  issueTitle: string;
  issueStatusName: string;
  projectId: string;
  repoPath: string;
}
export interface CleanupWarningEntry {
  id: string;
  branch: string;
  workingDir: string | null;
  cleanupWarning: string;
  closedAt: string | null;
  mergedAt: string | null;
  updatedAt: string | null;
  issueId: string;
  issueNumber: number;
  issueTitle: string;
  projectId: string;
}

export function createWorkspaceCleanupService(deps: {
  database: Database;
  getSessionManager?: () => SessionManager;
  gitService: GitService;
}) {
  const { database, getSessionManager, gitService } = deps;

  /**
   * Stop (graceful) then hard-kill the process TREE for every RUNNING session of a
   * workspace. The graceful stop only kills the main agent process; its descendants
   * (git / powershell / node) keep open file handles inside the worktree, which makes
   * the recursive directory removal race and fail on Windows (EBUSY/EPERM/ENOTEMPTY).
   * So the whole tree must die BEFORE the worktree is removed.
   */
  async function stopAndKillWorkspaceSessions(workspaceId: string): Promise<void> {
    const wsSessions = await crudRepo.getSessionsForWorkspace(workspaceId, database);
    const runningSessions = wsSessions.filter(s => s.status === "running");
    if (runningSessions.length === 0) return;

    if (getSessionManager) {
      for (const s of runningSessions) {
        // Graceful stop first (lets the agent flush + lets the session manager
        // mark the DB status as user-stopped).
        await getSessionManager().stopSession(s.id).catch(() => {});
      }
    }

    for (const s of runningSessions) {
      try {
        // `kill` taskkills the whole process tree (taskkill /T /F on Windows) using
        // the in-memory tracked pid. Fall back to the persisted sessions.pid for
        // detached/restored sessions whose ChildProcess handle is no longer tracked.
        const killed = killAgent(s.id);
        if (!killed && s.pid) {
          await killProcessTree(s.pid);
        }
      } catch (err) {
        console.warn(`[workspaces] failed to hard-kill session ${s.id} (pid=${s.pid ?? "?"})`, err);
      }
    }
  }

  /**
   * Tear down and remove a workspace's worktree + its feature branch. Frees dir/port
   * holders first (teardownWorktree) to avoid the Windows EBUSY removal race, then
   * removes via git (authoritative — also deletes the directory) with a retrying
   * directory-removal + prune fallback, and finally deletes the feature branch so the
   * next create re-cuts it from an up-to-date base (#781/#778). Every step is
   * best-effort and never throws.
   */
  async function removeWorktreeAndBranch(params: {
    workingDir: string;
    repoPath: string;
    isDirect: boolean;
    branch?: string | null;
    teardownScript?: string | null;
    setupEnabled?: boolean | null;
  }): Promise<void> {
    const { workingDir, repoPath, isDirect, branch, teardownScript, setupEnabled } = params;

    // Free everything the worktree spun up BEFORE removing it: dir procs + the
    // worktree's dev ports + the project's generic teardownScript. Killing the
    // dir/port holders first also prevents the EBUSY/ENOTEMPTY removal race.
    await teardownWorktree({ workingDir, branch, isDirect, teardownScript, setupEnabled, label: "delete" });

    // Use git as the authoritative step to drop the worktree registration + branch
    // (`git worktree remove --force` also deletes the directory). This succeeds even
    // when a stray file handle survives, and unlike `git worktree prune` it does not
    // require the directory to already be gone.
    let removed = false;
    try {
      await gitService.removeWorktree(repoPath, workingDir);
      removed = true;
    } catch (err) {
      console.warn(`[workspaces] git worktree remove failed for ${workingDir} — retrying directory removal`, err);
    }

    // Fall back to (or follow up with) a retrying directory removal. Windows releases
    // file handles asynchronously after a process dies, so a transient lock right
    // after the kill should not be treated as a permanent failure.
    const dirRemoved = await removeDirWithRetry(workingDir);

    // Final fallback: prune dangling registrations whose directory is now gone.
    await gitService.pruneWorktrees(repoPath).catch(() => {});

    if (!removed && !dirRemoved) {
      console.warn(`[workspaces] failed to fully clean up worktree at ${workingDir} — manual cleanup may be required`);
    }

    // Drop the feature branch too (#781). Removing only the worktree leaves the
    // branch behind; if a dependent issue is later recreated, createWorktree's reuse
    // path keeps that existing branch as-is and never re-cuts it from an up-to-date
    // base — reproducing the #778 "built against a pre-merge base" symptom. Only for
    // non-direct workspaces (direct ones run on the project's own branch, never delete it).
    if (branch) {
      await gitService.deleteBranch(repoPath, branch, { force: true }).catch((err) => {
        console.warn(`[workspaces] could not delete branch ${branch} after worktree removal (non-fatal)`, err);
      });
    }
  }

  /**
   * List closed/merged workspaces whose worktree directories still exist on disk.
   * Returns data needed by the stale-worktree cleanup UI: issue info, branch, status,
   * and whether the directory is still present.
   */
  async function listStaleWorktrees(projectId?: string): Promise<StaleWorktreeEntry[]> {
    const rows = await crudRepo.listStaleWorktreeRows(projectId, database);

    const results: StaleWorktreeEntry[] = [];

    for (const row of rows) {
      // Skip entries without a workingDir or repoPath
      if (!row.workingDir || !row.repoPath) continue;

      // Check if the directory actually still exists on disk
      if (!existsSync(row.workingDir)) continue;

      results.push({
        id: row.id,
        branch: row.branch,
        workingDir: row.workingDir,
        workspaceStatus: row.status,
        closedAt: row.closedAt,
        mergedAt: row.mergedAt,
        updatedAt: row.updatedAt,
        issueId: row.issueId,
        issueNumber: row.issueNumber ?? 0,
        issueTitle: row.issueTitle ?? "",
        issueStatusName: row.issueStatusName ?? "",
        projectId: row.projectId,
        repoPath: row.repoPath,
      });
    }

    return results;
  }

  /**
   * Safely remove a stale worktree directory. Validates that the workspace is closed
   * and that the workingDir is within the project's managed .worktrees/ directory,
   * rejecting arbitrary or unsafe paths.
   */
  async function removeStaleWorktree(workspaceId: string): Promise<{ success: boolean; error?: string }> {
    const workspace = await getWorkspaceById(workspaceId, database);
    if (!workspace) {
      return { success: false, error: "Workspace not found" };
    }
    if (workspace.status !== "closed") {
      return { success: false, error: "Workspace is not closed" };
    }
    if (!workspace.workingDir) {
      return { success: false, error: "Workspace has no working directory" };
    }

    const resolved = await resolveProjectRepo(workspaceId, database).catch(() => ({ repoPath: null as string | null, defaultBranch: null as string | null }));
    if (!resolved.repoPath) {
      return { success: false, error: "Could not resolve project repo path" };
    }
    const repoPath = resolved.repoPath;

    // Validate the workingDir is inside the managed .worktrees/ directory
    const worktreesRoot = pathResolve(dirname(repoPath), ".worktrees");
    const targetResolved = pathResolve(workspace.workingDir);
    const relativeToWorktreesRoot = relative(worktreesRoot, targetResolved);
    const root = pathParse(targetResolved).root;
    const isInsideWorktreesRoot = relativeToWorktreesRoot !== ""
      && relativeToWorktreesRoot !== ".."
      && !relativeToWorktreesRoot.startsWith(`..${sep}`)
      && pathParse(relativeToWorktreesRoot).root === "";

    if (targetResolved === pathResolve(repoPath) || targetResolved === root || !isInsideWorktreesRoot) {
      return { success: false, error: "Refusing to remove path outside managed worktrees directory" };
    }

    if (!existsSync(workspace.workingDir)) {
      // Directory already gone — just null out workingDir in DB
      const now = new Date().toISOString();
      await crudRepo.clearWorkspaceWorkingDir(workspaceId, now, database);
      return { success: true };
    }

    try {
      await gitService.removeWorktree(repoPath, workspace.workingDir);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { success: false, error: `Failed to remove worktree: ${message}` };
    }

    // Multi-repo: sibling worktrees + branches too (no-op single-repo). Stale
    // cleanup, like closeWorkspace, never touches the LEADING branch — so mirror
    // that per sibling repo: preserveUnmerged keeps a sibling branch that still
    // carries unmerged commits instead of force-deleting the work.
    await cleanupSiblingWorktrees(gitService, workspaceId, database, { preserveUnmerged: true });

    // Null out workingDir so it no longer shows as stale
    const now = new Date().toISOString();
    await crudRepo.clearWorkspaceWorkingDir(workspaceId, now, database);

    return { success: true };
  }

  /**
   * List closed workspaces that have a pending cleanup warning (worktree removal failed post-merge).
   */
  async function listCleanupWarnings(projectId?: string): Promise<CleanupWarningEntry[]> {
    const rows = await crudRepo.listCleanupWarningRows(projectId, database);

    return rows.map((row) => ({
        id: row.id,
        branch: row.branch,
        workingDir: row.workingDir,
        cleanupWarning: row.cleanupWarning as string,
        closedAt: row.closedAt,
        mergedAt: row.mergedAt,
        updatedAt: row.updatedAt,
        issueId: row.issueId,
        issueNumber: row.issueNumber ?? 0,
        issueTitle: row.issueTitle ?? "",
        projectId: row.projectId ?? "",
      }));
  }

  /**
   * Retry cleanup for a workspace with a pending cleanup warning. Runs the safe worktree
   * removal logic and clears the warning on success.
   */
  async function retryCleanup(workspaceId: string): Promise<{ success: boolean; error?: string }> {
    const workspace = await getWorkspaceById(workspaceId, database);
    if (!workspace) {
      return { success: false, error: "Workspace not found" };
    }
    if (workspace.status !== "closed") {
      return { success: false, error: "Workspace is not closed" };
    }
    if (!workspace.cleanupWarning) {
      return { success: false, error: "No pending cleanup warning for this workspace" };
    }

    // Reuse the safe stale-worktree removal logic which validates path safety.
    const result = await removeStaleWorktree(workspaceId);

    if (result.success) {
      // Clear the warning now that cleanup succeeded.
      await crudRepo.clearWorkspaceCleanupWarning(workspaceId, new Date().toISOString(), database);
    }

    return result;
  }

  return {
    stopAndKillWorkspaceSessions,
    removeWorktreeAndBranch,
    listStaleWorktrees,
    removeStaleWorktree,
    listCleanupWarnings,
    retryCleanup,
  };
}
