import { workspaces } from "@agentic-kanban/shared/schema";
import type { Database } from "../db/index.js";
import {
  getWorkspaceCloseState,
  applyWorkspaceClosePatch,
  getRunningSessionIdsForWorkspace,
  stopRunningSessionsForWorkspace,
} from "../repositories/workspace-lifecycle-reconcile.repository.js";

export interface CloseWorkspaceInput {
  database: Database;
  workspaceId: string;
  now?: string;
  closedAt?: string | null;
  mergedAt?: string | null;
  /** When false, mergedAt is left unchanged (non-merge closure). Defaults to true. */
  markMerged?: boolean;
  /** When provided, clears the workingDir column. */
  clearWorkingDir?: boolean;
}

export interface CloseWorkspaceResult {
  /** True when any column was actually updated (false = already closed, idempotent). */
  workspaceUpdated: boolean;
  closedAt: string;
  mergedAt: string | null;
}

/**
 * Pure workspace lifecycle close transition: sets status="closed", clears
 * readyForMerge, and stamps closedAt/mergedAt. Existing values win on retry
 * so merge history is never rewritten and board cache invalidations are
 * minimised.
 *
 * Does NOT touch issue status, sessions, or board events — those are the
 * responsibility of the caller. This makes the transition independently
 * testable without any issue/session/event infrastructure.
 */
export async function closeWorkspace(input: CloseWorkspaceInput): Promise<CloseWorkspaceResult> {
  const now = input.now ?? new Date().toISOString();
  const shouldMarkMerged = input.markMerged ?? true;

  const [workspace] = await getWorkspaceCloseState(input.workspaceId, input.database);

  if (!workspace) {
    throw new Error(`Workspace not found: ${input.workspaceId}`);
  }

  const closedAt = workspace.closedAt ?? input.closedAt ?? now;
  const mergedAt = shouldMarkMerged
    ? workspace.mergedAt ?? input.mergedAt ?? now
    : workspace.mergedAt;

  const patch: Partial<typeof workspaces.$inferSelect> = {
    status: "closed",
    closedAt,
    readyForMerge: false,
    updatedAt: now,
  };
  if (shouldMarkMerged) patch.mergedAt = mergedAt;
  if (input.clearWorkingDir) patch.workingDir = null;

  const workspaceUpdated =
    workspace.status !== "closed" ||
    workspace.closedAt !== closedAt ||
    Boolean(workspace.readyForMerge) ||
    (shouldMarkMerged && workspace.mergedAt !== mergedAt) ||
    (input.clearWorkingDir === true && workspace.workingDir !== null);

  if (workspaceUpdated) {
    await applyWorkspaceClosePatch(input.workspaceId, patch, input.database);
  }

  return {
    workspaceUpdated,
    closedAt,
    mergedAt: shouldMarkMerged ? mergedAt! : null,
  };
}

/**
 * Stop all running sessions for a workspace. Returns true when at least one
 * session was stopped.
 *
 * Extracted as a standalone function so the stop-sessions step can be tested
 * independently from the workspace status transition and issue reconciliation.
 */
export async function stopWorkspaceSessions(
  database: Database,
  workspaceId: string,
  endedAt: string,
): Promise<boolean> {
  const runningRows = await getRunningSessionIdsForWorkspace(workspaceId, database);

  if (runningRows.length === 0) return false;

  await stopRunningSessionsForWorkspace(workspaceId, endedAt, database);

  return true;
}
