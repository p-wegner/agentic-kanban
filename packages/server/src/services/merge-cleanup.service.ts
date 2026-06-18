import type { Database } from "../db/index.js";
import type { BoardEvents } from "./board-events.js";
import { closeWorkspace, stopWorkspaceSessions } from "./workspace-lifecycle-reconcile.service.js";
import {
  getIssueStatusAndProject,
  getIssueProject,
  getProjectStatusOptions,
  setIssueStatus,
} from "../repositories/merge-cleanup.repository.js";

export interface FinalizeMergeCleanupInput {
  database: Database;
  boardEvents?: BoardEvents;
  workspaceId: string;
  issueId: string;
  now?: string;
  projectId?: string | null;
  closedAt?: string | null;
  mergedAt?: string | null;
  workingDir?: string | null;
  markMerged?: boolean;
  fallbackToAiReviewed?: boolean;
}

export interface FinalizeMergeCleanupResult {
  projectId: string | null;
  closedAt: string;
  mergedAt: string | null;
  workspaceUpdated: boolean;
  issueTransitioned: boolean;
  sessionsStopped: boolean;
  broadcasted: boolean;
}

export interface ReconcileMergedIssueInput {
  database: Database;
  issueId: string;
  /** Timestamp to stamp the transition with; defaults to now. */
  now?: string;
  /** Project id; resolved from the issue when omitted. */
  projectId?: string | null;
  /** When no "Done" status exists, fall back to "AI Reviewed" (used by the merge path). */
  fallbackToAiReviewed?: boolean;
}

export interface ReconcileMergedIssueResult {
  projectId: string | null;
  /** True when this call actually moved the issue (false on a no-op / repeat call). */
  issueTransitioned: boolean;
  /** The status the issue was (or already is) reconciled to, when resolvable. */
  targetStatusId: string | null;
}

/**
 * Idempotently converge a merged issue to its terminal "Done" status.
 *
 * The single source of truth for post-merge issue-status reconciliation: invoked
 * from the merge success path (via {@link finalizeMergeCleanup}) AND the post-merge
 * sweep ({@link reconcileSilentlyMergedWorkspaces}), so a dropped HTTP response on the
 * merge call still converges the issue to Done on the next sweep. Calling it twice is
 * safe — once the issue already sits on the target status, every later call is a no-op
 * (issueTransitioned=false) and never rewrites statusChangedAt.
 */
export async function reconcileMergedIssue(
  input: ReconcileMergedIssueInput,
): Promise<ReconcileMergedIssueResult> {
  const now = input.now ?? new Date().toISOString();

  const issue = await getIssueStatusAndProject(input.issueId, input.database);

  if (!issue) {
    throw new Error(`Issue not found: ${input.issueId}`);
  }

  const projectId = input.projectId ?? issue.projectId ?? null;
  if (!projectId) {
    return { projectId: null, issueTransitioned: false, targetStatusId: null };
  }

  const statuses = await getProjectStatusOptions(projectId, input.database);
  const targetStatus = statuses.find((status) => status.name === "Done")
    ?? (input.fallbackToAiReviewed ? statuses.find((status) => status.name === "AI Reviewed") : undefined);

  if (!targetStatus) {
    console.warn(`[merge-cleanup] no Done status found for project ${projectId}`);
    return { projectId, issueTransitioned: false, targetStatusId: null };
  }

  // Idempotency hinges on this guard: a repeat call (or a sweep racing the merge
  // path) sees the issue already on the target status and does nothing.
  if (issue.statusId === targetStatus.id) {
    return { projectId, issueTransitioned: false, targetStatusId: targetStatus.id };
  }

  await setIssueStatus(input.issueId, targetStatus.id, now, input.database);

  return { projectId, issueTransitioned: true, targetStatusId: targetStatus.id };
}

/**
 * Finalize the DB-visible merge state before slower post-merge cleanup runs.
 * Composes {@link closeWorkspace} (lifecycle status transition) and
 * {@link reconcileMergedIssue} (issue status reconciliation) so callers that
 * need the combined behaviour can still call a single function, while unit
 * tests that need to verify each transition independently call the sub-functions
 * directly.
 */
export async function finalizeMergeCleanup(
  input: FinalizeMergeCleanupInput,
): Promise<FinalizeMergeCleanupResult> {
  const now = input.now ?? new Date().toISOString();
  const shouldMarkMerged = input.markMerged ?? true;

  const issue = await getIssueProject(input.issueId, input.database);

  if (!issue) {
    throw new Error(`Issue not found: ${input.issueId}`);
  }

  const projectId = input.projectId ?? issue.projectId ?? null;

  const { issueTransitioned } = await reconcileMergedIssue({
    database: input.database,
    issueId: input.issueId,
    now,
    projectId,
    fallbackToAiReviewed: input.fallbackToAiReviewed,
  });

  let workspaceUpdated = false;
  let closedAt = input.closedAt ?? now;
  let mergedAt: string | null = shouldMarkMerged ? input.mergedAt ?? now : null;

  try {
    const closed = await closeWorkspace({
      database: input.database,
      workspaceId: input.workspaceId,
      now,
      closedAt: input.closedAt ?? now,
      mergedAt: input.mergedAt ?? now,
      markMerged: shouldMarkMerged,
      clearWorkingDir: input.workingDir !== undefined,
    });
    workspaceUpdated = closed.workspaceUpdated;
    closedAt = closed.closedAt;
    mergedAt = closed.mergedAt;
  } catch (err) {
    // #668: The git merge has already been verified (ancestry check passed)
    // before we reach this point. Rolling back the issue → Done transition here
    // would strand the issue In Review with the branch already on master.
    // Instead, log the workspace close failure — the startup reconciler
    // (reconcileSilentlyMergedWorkspaces, via mergedAt) will clean up the
    // workspace on next boot if needed.
    console.warn(
      `[merge-cleanup] workspace close failed after issue transitioned to Done (workspaceId=${input.workspaceId}). ` +
        "Issue will remain Done — the workspace can be reconciled on next startup.",
      err instanceof Error ? err.message : String(err),
    );
  }

  const sessionsStopped = await stopWorkspaceSessions(input.database, input.workspaceId, now).catch((err) => {
    console.warn(
      `[merge-cleanup] failed to stop running sessions after merge finalization (workspaceId=${input.workspaceId}).`,
      err instanceof Error ? err.message : String(err),
    );
    return false;
  });

  const broadcasted = Boolean(input.boardEvents && projectId && (workspaceUpdated || issueTransitioned || sessionsStopped));
  if (broadcasted) {
    input.boardEvents?.broadcast(projectId!, "workspace_merged");
  }

  return {
    projectId,
    closedAt,
    mergedAt,
    workspaceUpdated,
    issueTransitioned,
    sessionsStopped,
    broadcasted,
  };
}
