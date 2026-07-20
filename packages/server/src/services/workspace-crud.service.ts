import type { Database } from "../db/index.js";
import type { SessionManager } from "./session.manager.js";
import type { BoardEvents } from "./board-events.js";
import { deleteWorkspaceCascade } from "../repositories/workspace.repository.js";
import * as crudRepo from "../repositories/workspace-crud.repository.js";

// Teardown/cleanup ops + their entry types now live in workspace-cleanup.service.ts.
// Re-export the types so existing importers (workspace.service.ts) are unaffected.
export type { StaleWorktreeEntry, CleanupWarningEntry } from "./workspace-cleanup.service.js";

import * as realGitService from "./git.service.js";
import {
  resolveProjectRepo,
  resolveProjectId,
  getWorkspaceById,
  getWorkspaceDetails,
} from "../repositories/workspace.repository.js";
import {
  WorkspaceError,
  requireBaseBranch,
  type GitService,
} from "./workspace-internals.js";
import { createWorkspaceCleanupService } from "./workspace-cleanup.service.js";
import { cleanupSiblingWorktrees } from "./workspace-repos.service.js";
import { createWorkspaceCreateService } from "./workspace-create.service.js";
import { workspaceServicesService, parseStoredComposeProjectName } from "./workspace-services.service.js";
import { reapWorkspaceContainer } from "./devcontainer-workspace.service.js";
import { resolveProjectDevServerPlan } from "./dev-server.service.js";
import { isSelfProjectRepo } from "./self-project.js";
import type { WorkspaceDevServerPlanResponse } from "@agentic-kanban/shared";

export function createWorkspaceCrudService(deps: {
  database: Database;
  getSessionManager?: () => SessionManager;
  boardEvents?: BoardEvents;
  gitService?: GitService;
}) {
  const { database, getSessionManager, boardEvents } = deps;
  const gitService = deps.gitService ?? realGitService;

  // Teardown/cleanup ops (stop+kill, worktree removal, stale-worktree + cleanup-warning
  // maintenance) live in a sibling service sharing the same injected deps.
  const cleanup = createWorkspaceCleanupService({ database, getSessionManager, gitService });
  const { stopAndKillWorkspaceSessions, removeWorktreeAndBranch } = cleanup;

  // Workspace creation + launch-preview (worktree setup, agent config/skill/prompt,
  // DB insert, deferred launch) live in a sibling service sharing the same deps.
  const create = createWorkspaceCreateService({ database, getSessionManager, boardEvents, gitService });

  async function deleteWorkspace(workspaceId: string): Promise<void> {
    await stopAndKillWorkspaceSessions(workspaceId);

    const wsRow = await crudRepo.getWorkspaceDeletionContext(workspaceId, database);
    const workingDir = wsRow[0]?.workingDir;
    const isDirect = wsRow[0]?.isDirect;
    const repoPath = wsRow[0]?.repoPath;
    const deletedProjectId = wsRow[0]?.projectId;

    // Multi-repo: remove sibling worktrees + branches BEFORE the cascade deletes
    // the workspace's `repos` rows that record where they live. No-op single-repo.
    await cleanupSiblingWorktrees(gitService, workspaceId, database);

    await deleteWorkspaceCascade(workspaceId, database);

    // Per-workspace Docker service stack teardown runs UNCONDITIONALLY (stacks are
    // keyed per workspace/compose project, NOT per worktree) — it must not hide behind
    // the sharedByOthers worktree gate below, or a deleted sharer's own stack leaks
    // (finding 12). The engine's last-reference guard skips the down while another
    // live workspace still references the SAME compose project (shared-worktree
    // adoption), so the last sharer to go downs the shared stack. Uses the STORED
    // compose project name (never a recompute, #F1). Best-effort — never throws.
    if (workingDir && !isDirect && repoPath) {
      const delComposeName = parseStoredComposeProjectName(wsRow[0]?.serviceState);
      if (delComposeName) {
        await workspaceServicesService.teardownWorkspaceServices({
          composeProjectName: delComposeName,
          composeWorktreePath: workingDir,
          releasedByWorkspaceId: workspaceId,
        });
      }
    }

    // A shared-worktree fork child reuses its parent's workingDir. Never remove the
    // directory while another (e.g. the parent) workspace still points at it — this
    // row is already deleted above, so any match here is a genuine other sharer.
    let sharedByOthers = false;
    if (workingDir && !isDirect && repoPath) {
      const sharers = await crudRepo.findWorkspacesByWorkingDir(workingDir, database);
      sharedByOthers = sharers.length > 0;
      if (sharedByOthers) {
        console.log(`[workspaces] worktree ${workingDir} still referenced by ${sharers.length} other workspace(s) — skipping removal`);
      }
    }

    if (workingDir && !isDirect && repoPath && !sharedByOthers) {
      await removeWorktreeAndBranch({
        workingDir,
        repoPath,
        isDirect,
        branch: wsRow[0]?.branch,
        teardownScript: wsRow[0]?.teardownScript,
        setupEnabled: wsRow[0]?.setupEnabled,
        workspaceId,
      });
    }

    if (deletedProjectId) boardEvents?.broadcast(deletedProjectId, "workspace_closed");
  }

  /**
   * Close a workspace WITHOUT merging — for work that was abandoned or already
   * merged out-of-band. Stops any running agent, removes the worktree (non-direct),
   * and sets status to "closed" with a closedAt timestamp. Leaves mergedAt null so
   * the UI distinguishes a manual close from a real merge. Preserves session history
   * (unlike deleteWorkspace, which destroys the record).
   */
  async function closeWorkspace(workspaceId: string): Promise<{ id: string; status: "closed" }> {
    const workspace = await getWorkspaceById(workspaceId, database);
    if (!workspace) throw new WorkspaceError("Workspace not found", "NOT_FOUND");
    if (workspace.status === "closed") return { id: workspaceId, status: "closed" };

    // Stop any RUNNING agent so it doesn't keep working against a closed workspace.
    // Only target running sessions — stopSession unconditionally rewrites status to
    // "stopped"/endedAt, so calling it on already-completed sessions would corrupt the
    // very history this close path promises to preserve (see deleteWorkspace).
    const wsSessions = await crudRepo.getSessionStatusesForWorkspace(workspaceId, database);
    const runningSessions = wsSessions.filter((s) => s.status === "running");
    if (getSessionManager) {
      for (const s of runningSessions) {
        await getSessionManager().stopSession(s.id).catch(() => {});
      }
    }

    // Clean up the worktree for non-direct workspaces (mirrors merge/close behaviour).
    if (!workspace.isDirect && workspace.workingDir) {
      // Per-workspace Docker service stack down (only when one was provisioned) before
      // the worktree goes away. Uses the STORED compose project name (#F1). Best-effort —
      // the engine never throws. This workspace's own (still-live) row must not block
      // its own release, so it is passed as the releaser; the engine's last-reference
      // guard still skips the down while a co-resident sharer references the stack.
      const closeComposeName = parseStoredComposeProjectName(workspace.serviceState);
      if (closeComposeName) {
        await workspaceServicesService.teardownWorkspaceServices({
          composeProjectName: closeComposeName,
          composeWorktreePath: workspace.workingDir,
          releasedByWorkspaceId: workspaceId,
        });
      }
      // Devcontainer builder teardown (#138), also before the worktree goes away:
      // the container bind-mounts this directory, and its dependency volumes
      // cannot be removed while it still holds them. No-op when the workspace was
      // never containerized (nothing matches the label / name prefix).
      await reapWorkspaceContainer({ worktreePath: workspace.workingDir, workspaceId });

      const { repoPath } = await resolveProjectRepo(workspaceId, database).catch(() => ({ repoPath: null as string | null }));
      if (repoPath) {
        try { await gitService.removeWorktree(repoPath, workspace.workingDir); } catch { /* best effort */ }
      }
      // Multi-repo: sibling worktrees + branches too (no-op single-repo). Close
      // deliberately preserves the LEADING branch (worktree removal only, above) so
      // abandoned work stays recoverable — preserveUnmerged mirrors that per sibling
      // repo: a sibling branch with unmerged commits survives instead of being
      // force-deleted (only fully-merged/empty sibling branches are dropped).
      await cleanupSiblingWorktrees(gitService, workspaceId, database, { preserveUnmerged: true });
    }

    const now = new Date().toISOString();
    await crudRepo.updateWorkspaceClosed(
      workspaceId,
      { status: "closed", workingDir: workspace.isDirect ? workspace.workingDir : null, closedAt: now, updatedAt: now },
      database,
    );

    const projectId = await resolveProjectId(workspaceId, database);
    if (projectId) boardEvents?.broadcast(projectId, "workspace_closed");

    return { id: workspaceId, status: "closed" };
  }

  async function markReadyForMerge(workspaceId: string): Promise<{ id: string; readyForMerge: boolean }> {
    const wsRows = await crudRepo.getWorkspaceIssueId(workspaceId, database);
    if (wsRows.length === 0) {
      throw new WorkspaceError("Workspace not found", "NOT_FOUND");
    }

    const now = new Date().toISOString();
    await crudRepo.setWorkspaceReadyForMerge(workspaceId, now, database);

    if (boardEvents) {
      const issueRows = await crudRepo.getIssueProjectIdById(wsRows[0].issueId, database);
      if (issueRows.length > 0) {
        boardEvents.broadcast(issueRows[0].projectId, "workspace_ready_for_merge");
      }
    }

    return { id: workspaceId, readyForMerge: true };
  }

  async function setupWorkspace(id: string) {
    const workspace = await getWorkspaceById(id, database);
    if (!workspace) throw new WorkspaceError("Workspace not found", "NOT_FOUND");

    if (workspace.workingDir) {
      return { id, workingDir: workspace.workingDir };
    }

    const { repoPath, defaultBranch } = await resolveProjectRepo(id, database);
    const baseBranch = requireBaseBranch(workspace.baseBranch || defaultBranch);
    console.log(`[workspace-service] setup: workspaceId=${id} branch=${workspace.branch} repoPath=${repoPath} baseBranch=${baseBranch}`);

    const worktreePath = await gitService.createWorktree(repoPath, workspace.branch, baseBranch);
    console.log(`[workspace-service] setup complete: workspaceId=${id} worktreePath=${worktreePath}`);

    const now = new Date().toISOString();
    await crudRepo.setWorkspaceWorkingDir(id, { workingDir: worktreePath, baseBranch, updatedAt: now }, database);

    const projectId = await resolveProjectId(id, database);
    if (projectId) boardEvents?.broadcast(projectId, "workspace_setup");

    return { id, workingDir: worktreePath };
  }

  async function updateWorkspace(id: string, body: Record<string, unknown>): Promise<{ id: string }> {
    const validStatuses = ["active", "reviewing", "idle", "blocked", "closed"];
    if (body.status && !validStatuses.includes(body.status as string)) {
      throw new WorkspaceError("Invalid status. Must be active, reviewing, idle, blocked, or closed", "BAD_REQUEST");
    }

    const now = new Date().toISOString();
    const updates: Record<string, unknown> = { updatedAt: now };
    if (body.status !== undefined) updates.status = body.status;
    if (body.workingDir !== undefined) updates.workingDir = body.workingDir;
    if (body.planMode !== undefined) updates.planMode = body.planMode === true;
    if (body.claudeProfile !== undefined) updates.claudeProfile = body.claudeProfile ?? null;
    if (body.provider !== undefined) updates.provider = body.provider ?? null;

    await crudRepo.applyWorkspaceUpdates(id, updates, database);

    return { id };
  }

  async function getWorkspace(id: string) {
    return getWorkspaceDetails(id, database);
  }

  /**
   * Resolve the honest dev-server plan for a workspace — the command/health-URL/port
   * the board would actually boot for THIS project, with provenance. Powers the
   * diagnostics tab so it never shows this app's private 3001/5173 worktree ports for a
   * project that doesn't use them (ticket #100). The worktree-port fallback is applied
   * only when the workspace belongs to the board's own checkout (isSelfProject).
   */
  async function getWorkspaceDevServerPlan(id: string): Promise<WorkspaceDevServerPlanResponse | null> {
    const workspace = await getWorkspaceById(id, database);
    if (!workspace) return null;

    const projectId = await resolveProjectId(id, database);
    if (!projectId) return { workspaceId: id, isSelfProject: false, plan: null };

    const repoPath = await resolveProjectRepo(id, database)
      .then((r) => r.repoPath)
      .catch(() => null);
    const isSelfProject = isSelfProjectRepo(repoPath);

    const plan = await resolveProjectDevServerPlan(projectId, database, {
      workingDir: workspace.workingDir,
      isSelfProject,
    });
    return { workspaceId: id, isSelfProject, plan };
  }

  return {
    createWorkspace: create.createWorkspace,
    deleteWorkspace,
    closeWorkspace,
    markReadyForMerge,
    setupWorkspace,
    updateWorkspace,
    getWorkspace,
    getWorkspaceDevServerPlan,
    listStaleWorktrees: cleanup.listStaleWorktrees,
    removeStaleWorktree: cleanup.removeStaleWorktree,
    listCleanupWarnings: cleanup.listCleanupWarnings,
    retryCleanup: cleanup.retryCleanup,
    computeLaunchPreview: create.computeLaunchPreview,
  };
}
