import type { Database } from "../db/index.js";
import type { BoardEventSink } from "./board-events.js";
import { closeWorkspace, stopWorkspaceSessions } from "./workspace-lifecycle-reconcile.service.js";
import {
  getIssueStatusAndProject,
  getIssueProject,
  getProjectStatusOptions,
  setIssueStatus,
} from "../repositories/merge-cleanup.repository.js";
import { listMemberIssueIds } from "../repositories/workspace-issue-members.repository.js";
import { errorMessage } from "@agentic-kanban/shared/lib/error-message";

export interface FinalizeMergeCleanupInput {
  database: Database;
  boardEvents?: BoardEventSink;
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
  /**
   * When the work actually landed (the merged workspace's `mergedAt`). Supplying it turns
   * the reconcile into a CATCH-UP: it converges the issue only when its current status
   * predates the merge. Without it the reconcile is unconditional, which is only correct
   * on the merge path itself (where the merge IS the latest event).
   *
   * Why it matters: the monitor's already-merged sweep runs every cycle, forever. Force-
   * setting Done with no recency check meant a human who deliberately REOPENED a merged
   * ticket (Done → Todo, because the work was wrong or incomplete) had it silently
   * flipped back to Done on the next cycle — repeatedly, with no audit trail, so the
   * board looked like it was fighting the operator.
   */
  mergedAt?: string | null;
}

export interface ReconcileMergedIssueResult {
  projectId: string | null;
  /** True when this call actually moved the issue (false on a no-op / repeat call). */
  issueTransitioned: boolean;
  /** The status the issue was (or already is) reconciled to, when resolvable. */
  targetStatusId: string | null;
  /**
   * Set when the issue was left alone because its status was changed AFTER the merge —
   * i.e. someone reopened it on purpose. Callers surface this instead of silently
   * treating the no-op as "already Done".
   */
  reopenedAfterMerge?: boolean;
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
/**
 * True when the issue's status transition is strictly newer than the merge. Unparseable or
 * missing timestamps return false — the guard must never *block* reconciliation on bad data,
 * only on a demonstrably later status change.
 */
function isStatusNewerThanMerge(statusChangedAt: string | null | undefined, mergedAt: string): boolean {
  if (!statusChangedAt) return false;
  const statusTime = Date.parse(statusChangedAt);
  const mergeTime = Date.parse(mergedAt);
  if (Number.isNaN(statusTime) || Number.isNaN(mergeTime)) return false;
  return statusTime > mergeTime;
}

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

  // Recency guard (only for catch-up callers that pass `mergedAt`): the merge is old news
  // once the issue's status was changed AFTER it. That is a deliberate reopen, not a status
  // that failed to catch up — converging it to Done would overwrite the operator's decision
  // on every single cycle. `>` (not `>=`) so the merge path's own call, which stamps the
  // transition and the merge at the same instant, still converges.
  if (input.mergedAt && isStatusNewerThanMerge(issue.statusChangedAt, input.mergedAt)) {
    return { projectId, issueTransitioned: false, targetStatusId: targetStatus.id, reopenedAfterMerge: true };
  }

  await setIssueStatus(input.issueId, targetStatus.id, now, input.database);

  return { projectId, issueTransitioned: true, targetStatusId: targetStatus.id };
}

/**
 * Ticket group (#661): converge every MEMBER issue of a merged group workspace to Done,
 * via the same idempotent, recency-guarded {@link reconcileMergedIssue} the lead uses.
 * One member failing must not strand the rest, so each is reconciled independently and
 * failures are logged (the silently-merged reconciler converges stragglers on next boot,
 * because it re-enters {@link finalizeMergeCleanup}, which calls this again).
 *
 * Returns the number of member issues that actually transitioned. Callers with a
 * workspace id in hand should call this beside every terminal issue-status write —
 * {@link finalizeMergeCleanup} does it internally, so only the Done writers that bypass
 * it (exit-workflow autoMerge, the monitor's direct-workspace close) need their own call.
 */
export async function reconcileGroupMemberIssues(input: {
  database: Database;
  workspaceId: string;
  now?: string;
  projectId?: string | null;
  mergedAt?: string | null;
  fallbackToAiReviewed?: boolean;
}): Promise<number> {
  let memberIds: string[] = [];
  try {
    memberIds = await listMemberIssueIds(input.workspaceId, input.database);
  } catch (err) {
    console.warn(`[merge-cleanup] failed to list ticket-group members for workspace ${input.workspaceId}:`, errorMessage(err));
    return 0;
  }
  let transitioned = 0;
  for (const issueId of memberIds) {
    try {
      const res = await reconcileMergedIssue({
        database: input.database,
        issueId,
        now: input.now,
        projectId: input.projectId,
        mergedAt: input.mergedAt,
        fallbackToAiReviewed: input.fallbackToAiReviewed,
      });
      if (res.issueTransitioned) transitioned++;
    } catch (err) {
      console.warn(`[merge-cleanup] ticket-group member ${issueId} failed to converge after merge of workspace ${input.workspaceId}:`, errorMessage(err));
    }
  }
  if (transitioned > 0) {
    console.log(`[merge-cleanup] ticket group: converged ${transitioned}/${memberIds.length} member issue(s) of workspace ${input.workspaceId}`);
  }
  return transitioned;
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

  // Ticket group (#661): a merged group workspace lands ALL its tickets, so the member
  // issues converge to Done alongside the lead. No-op for single-ticket workspaces.
  const membersTransitioned = await reconcileGroupMemberIssues({
    database: input.database,
    workspaceId: input.workspaceId,
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
      errorMessage(err),
    );
  }

  const sessionsStopped = await stopWorkspaceSessions(input.database, input.workspaceId, now).catch((err) => {
    console.warn(
      `[merge-cleanup] failed to stop running sessions after merge finalization (workspaceId=${input.workspaceId}).`,
      errorMessage(err),
    );
    return false;
  });

  const broadcasted = Boolean(input.boardEvents && projectId && (workspaceUpdated || issueTransitioned || membersTransitioned > 0 || sessionsStopped));
  if (broadcasted) {
    input.boardEvents?.broadcast(projectId, "workspace_merged");
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
