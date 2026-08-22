import type { Database } from "../db/index.js";
import type { SessionLauncher } from "./session.manager.js";
import type { BoardEventSink } from "./board-events.js";
import { deleteWorkspaceCascade } from "../repositories/workspace.repository.js";
import * as crudRepo from "../repositories/workspace-crud.repository.js";
import { errorMessage } from "@agentic-kanban/shared/lib/error-message";

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
  withStepTimeout,
  type GitService,
} from "./workspace-internals.js";
import { createWorkspaceCleanupService } from "./workspace-cleanup.service.js";
import { cleanupSiblingWorktrees } from "./workspace-repos.service.js";
import { createWorkspaceCreateService } from "./workspace-create.service.js";
import { releaseWorkspaceResources } from "./workspace-resource-release.js";
import { resolveProjectDevServerPlan } from "./dev-server.service.js";
import { isSelfProjectRepo } from "./self-project.js";
import type { WorkspaceDevServerPlanResponse } from "@agentic-kanban/shared";
import { resolveWorktreeClaims, removeWorktreeUnlessShared } from "@agentic-kanban/shared/lib/worktree-claim";

export function createWorkspaceCrudService(deps: {
  database: Database;
  getSessionManager?: () => SessionLauncher;
  boardEvents?: BoardEventSink;
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

    // Runs UNCONDITIONALLY, ahead of the sharedByOthers worktree gate below: stacks are
    // keyed per workspace/compose project, NOT per worktree, so hiding this behind that
    // gate leaks a deleted sharer's own stack (finding 12). The engine's last-reference
    // guard is what protects a genuinely SHARED stack.
    await releaseWorkspaceResources({ id: workspaceId, workingDir, isDirect, serviceState: wsRow[0]?.serviceState });

    // A shared-worktree fork child reuses its parent's workingDir. Never remove the
    // directory while another (e.g. the parent) workspace still points at it — this
    // row is already deleted above, so any match here is a genuine other sharer.
    //
    // #713: routed through the ONE guarded removal. This copy of the check was a bare
    // `sharers.length > 0` — it counted a CLOSED sharer as live and so refused forever —
    // and its sibling in workspace-cleanup compared the literal `"closed"` instead of the
    // shared liveness vocabulary, so `merged` (and any future terminal status) disagreed
    // between the two. `removeWorktreeUnlessShared` answers both with `holdsLiveResources`.
    if (workingDir && !isDirect && repoPath) {
      await removeWorktreeUnlessShared({
        database,
        workingDir,
        workspaceId,
        label: "delete-workspace",
        removeWorktree: () => removeWorktreeAndBranch({
          workingDir,
          repoPath,
          isDirect,
          branch: wsRow[0]?.branch,
          teardownScript: wsRow[0]?.teardownScript,
          setupEnabled: wsRow[0]?.setupEnabled,
          workspaceId,
        }),
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
        await withStepTimeout(`stop-session:${s.id}`, () => getSessionManager().stopSession(s.id)).catch((err) => {
          console.warn(`[workspaces] close: stopSession step failed/timed out for session ${s.id} (best-effort)`, err);
        });
      }
    }

    // Clean up the worktree for non-direct workspaces (mirrors merge/close behaviour).
    // Every step below is bounded by withStepTimeout (#268): before this fix a single
    // wedged step (an unbounded fs walk breaking junctions, a git call blocked on a
    // Windows file handle, a hung docker/compose call) made the whole close request
    // hang with no HTTP response at all, which also strands the issue In Progress
    // (the board refuses Done while an unmerged workspace stays open).
    let workingDirRemoved = workspace.isDirect;
    let cleanupWarning: string | null = null;
    if (!workspace.isDirect && workspace.workingDir) {
      // Stack + container, before the worktree goes away. This workspace's own
      // (still-live) row must not block its own release, so it is passed as the
      // releaser; the engine's last-reference guard still skips the down while a
      // co-resident sharer references the stack.
      await releaseWorkspaceResources(
        { id: workspaceId, workingDir: workspace.workingDir, isDirect: workspace.isDirect, serviceState: workspace.serviceState },
        { step: withStepTimeout, phase: "close" },
      );

      const { repoPath } = await resolveProjectRepo(workspaceId, database).catch(() => ({ repoPath: null as string | null }));
      if (repoPath) {
        try {
          // #713: closeWorkspace is a SIXTH co-residency delete site — the same shape as
          // mcp `close_workspace`, and the ticket's list did not name it. Guarded like the
          // rest: a live sharer's checkout must survive this close. A refusal lands in the
          // same cleanup-warning escape hatch as a failed removal, which is exactly right —
          // the directory legitimately stays and should be discoverable, not silent.
          await withStepTimeout("remove-worktree", async () => {
            const outcome = await removeWorktreeUnlessShared({
              database,
              workingDir: workspace.workingDir!,
              workspaceId,
              label: "close-workspace",
              removeWorktree: () => gitService.removeWorktree(repoPath, workspace.workingDir!),
            });
            if (!outcome.removed) {
              throw outcome.reason === "remove-failed" ? outcome.error : new Error(outcome.message);
            }
          });
          workingDirRemoved = true;
        } catch (err) {
          // Escape hatch (#268): a worktree that cannot be cleanly removed — whether
          // git itself failed or the step ran past its bound (e.g. a wedged Windows
          // file handle) — must never block the close. Close never deletes the
          // branch either way, so nothing but disk is lost by leaving the directory
          // behind; recording it as a cleanup warning (mirrors the post-merge
          // cleanup pattern) keeps it discoverable via the Cleanup Queue instead of
          // silently falling out of tracking.
          cleanupWarning = errorMessage(err);
          console.warn(`[workspaces] close: worktree removal failed/timed out for ${workspace.workingDir} — recording cleanup warning`, err);
        }
      }
      // Multi-repo: sibling worktrees + branches too (no-op single-repo). Close
      // deliberately preserves the LEADING branch (worktree removal only, above) so
      // abandoned work stays recoverable — preserveUnmerged mirrors that per sibling
      // repo: a sibling branch with unmerged commits survives instead of being
      // force-deleted (only fully-merged/empty sibling branches are dropped).
      await withStepTimeout("cleanup-sibling-worktrees", () =>
        cleanupSiblingWorktrees(gitService, workspaceId, database, { preserveUnmerged: true }),
      ).catch((err) => console.warn(`[workspaces] close: sibling worktree cleanup failed/timed out for ${workspaceId} (best-effort)`, err));
    }

    const now = new Date().toISOString();
    await crudRepo.updateWorkspaceClosed(
      workspaceId,
      {
        status: "closed",
        workingDir: workingDirRemoved ? (workspace.isDirect ? workspace.workingDir : null) : workspace.workingDir,
        closedAt: now,
        updatedAt: now,
        cleanupWarning,
      },
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

    // #713: this is #699's OWN scenario — recreating a worktree for a workspace whose
    // directory went missing — and it was the one path that never got the guard, so the
    // recursive leftover-delete ran on git's word alone.
    const worktreePath = await gitService.createWorktree(repoPath, workspace.branch, baseBranch, {
      ...(await resolveWorktreeClaims(database, { label: "setup-workspace" })),
    });
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
