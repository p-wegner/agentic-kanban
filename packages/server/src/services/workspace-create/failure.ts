/**
 * The create-failure COMPENSATION path, lifted out of workspace-create.service.ts.
 *
 * Creation provisions two resources that do not share a transaction: the on-disk git
 * worktree + branch (before the DB transaction opens) and the workspace row (inside it).
 * Everything in here exists to close that gap in one direction — when the second half
 * fails, undo the first — so the orchestration in workspace-create.service.ts reads as
 * the happy path plus one named call.
 *
 * Kept as a factory over `{ gitService, database }` rather than free functions because
 * both halves need the substitutable gitService the create service already injects, and
 * that is the seam the create-path tests drive.
 */

import { emitButlerSystemEvent } from "../butler-event-feed.js";
import * as crudRepo from "../../repositories/workspace-crud.repository.js";
import type { Database } from "../../db/index.js";
import type { ProviderName } from "../agent-provider.js";
import type { CreateWorkspaceResult, GitService } from "../workspace-internals.js";
import { errorMessage } from "@agentic-kanban/shared/lib/error-message";

export interface HandleCreateFailureParams {
  id: string;
  issueId: string;
  branch: string;
  worktreePath: string | null;
  repoPath: string | null;
  baseBranch: string | null;
  isDirect: boolean;
  baseCommitSha: string | null;
  requiresReview: boolean;
  thoroughReview: boolean;
  planMode: boolean;
  includeVisualProof: boolean;
  claudeProfile: string | undefined;
  agentCommand: string | undefined;
  resolvedProvider: ProviderName;
  now: string;
}

export function createWorkspaceCreateFailureHandler(deps: {
  gitService: GitService;
  database: Database;
}) {
  const { gitService, database } = deps;

  /**
   * Compensating rollback for the on-disk git worktree + branch provisioned by
   * setupWorktree BEFORE the DB transaction opens. Cross-resource atomicity gap
   * (#893): if anything after provisioning throws (txn rollback, workflow-init
   * failure, or a WorkspaceError surfaced from agent-config resolution), the
   * worktree directory + branch persist with no backing DB row — an orphan the
   * board can't see or cascade-clean. Removing it here is the compensation step.
   *
   * No-op for direct workspaces (they reuse the main checkout — there is nothing
   * to remove) and when no worktree was provisioned (failure happened earlier).
   * Best-effort: a failed removal is logged, never re-thrown, so it can't mask the
   * original error.
   */
  async function rollbackOrphanedWorktree(
    isDirect: boolean,
    worktreePath: string | null,
    repoPath: string | null,
  ): Promise<void> {
    if (isDirect || !worktreePath || !repoPath) return;
    try {
      await gitService.removeWorktree(repoPath, worktreePath);
      console.log(`[workspaces] cleaned up orphaned worktree: ${worktreePath}`);
    } catch (cleanupErr) {
      console.warn(`[workspaces] failed to remove worktree after create error: ${errorMessage(cleanupErr)}`);
    }
  }

  async function handleCreateFailure(
    err: unknown,
    params: HandleCreateFailureParams,
  ): Promise<CreateWorkspaceResult> {
    const errorMsg = errorMessage(err);
    console.error(`[workspaces] create failed: ${errorMsg}`);

    try {
      const projectId = await crudRepo.getIssueProjectId(params.issueId, database);
      if (projectId) {
        emitButlerSystemEvent({ projectId, kind: "workspace_error", workspaceId: params.id, text: `Workspace creation failed for issue ${params.issueId} (branch ${params.branch}): ${errorMsg.slice(0, 200)}` });
      }
    } catch { /* best-effort */ }

    await rollbackOrphanedWorktree(params.isDirect, params.worktreePath, params.repoPath);

    return {
      id: params.id,
      issueId: params.issueId,
      branch: params.branch,
      workingDir: params.worktreePath,
      baseBranch: params.baseBranch,
      isDirect: params.isDirect,
      planMode: params.planMode,
      includeVisualProof: params.includeVisualProof,
      status: "error",
      provider: params.resolvedProvider,
      createdAt: params.now,
      updatedAt: params.now,
      error: errorMsg,
    };
  }

  return { rollbackOrphanedWorktree, handleCreateFailure };
}
