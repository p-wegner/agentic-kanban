import { transitionIssueStatus } from "@agentic-kanban/shared/lib/workflow-engine";
import { projectStatuses } from "@agentic-kanban/shared/schema";
import { sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { setWorkspaceStatus } from "../repositories/workspace-status.repository.js";
import type { MonitorActionName } from "../services/monitor-nudge.js";
import type { MonitorAction } from "./monitor-helpers.js";
import type { WorkspaceCandidate } from "./monitor-cycle.js";
import type { MonitorWorkspaceActions } from "./monitor-workspace-actions.js";
import type { MergeGateToken } from "../services/pre-merge-gate.service.js";
import { clearWorkspaceWorkingDir } from "../repositories/workspace-crud.repository.js";
import { clearMergeBackoff, recordMergeFailure, type MergeBackoffDeps } from "../services/merge-backoff.service.js";
import { errorMessage } from "@agentic-kanban/shared/lib/error-message";
import { closeWorkspace } from "../services/workspace-lifecycle-reconcile.service.js";

export type LogMonitorActionFn = (action: MonitorActionName, workspaceId: string, issueId: string, extra?: Pick<MonitorAction, "endpoint" | "httpStatus" | "responseSummary" | "verificationResult">) => void;

/** Looks up a project status id by name. Issues exactly ONE db.select per invocation. */
export async function getProjectStatusIdByName(projectId: string, name: string): Promise<string | undefined> {
  const rows = await db.select({ id: projectStatuses.id }).from(projectStatuses)
    .where(sql`${projectStatuses.name} = ${name} AND ${projectStatuses.projectId} = ${projectId}`).limit(1);
  return rows[0]?.id;
}

/**
 * Triggers a merge for the workspace; on failure (conflict, lock, etc.) falls
 * back to fix-and-merge with the merge error. Calls the workspace application
 * service DIRECTLY via the injected port — NOT over self-HTTP. A rejected merge
 * promise maps 1:1 to the old non-2xx/network-failure branch, so the fix-and-merge
 * fallback fires under exactly the same conditions. The caller keeps ownership of
 * `stats.merged++` (a failed merge that fell back still consumes a merge slot, by
 * design) and of broadcasting the board change.
 *
 * #417 backoff bookkeeping: a success clears any recorded merge backoff; a failure
 * records it (identical repeats double the retry window; the >=2-repeat warning
 * surfaces via a `merge_retry_blocked` drive obstacle). The SKIP decision itself is
 * made by the caller BEFORE consuming a merge slot — see `shouldSkipMergeForBackoff`
 * in monitor-cycle.ts — so a blocked workspace cannot starve other merges.
 */
export async function mergeWorkspaceWithFixFallback(
  ws: WorkspaceCandidate,
  workspaceActions: MonitorWorkspaceActions,
  logAction: LogMonitorActionFn,
  logs: { conflictMsg: string; successMsg: string },
  gate: MergeGateToken,
  backoff?: MergeBackoffDeps,
): Promise<void> {
  try {
    await workspaceActions.merge(ws.wsId, gate);
    await clearMergeBackoff((backoff?.database ?? db), ws.wsId);
    console.log(logs.successMsg);
    logAction("merge", ws.wsId, ws.issueId, {
      endpoint: `POST /api/workspaces/${ws.wsId}/merge`,
      verificationResult: "ok",
    });
  } catch (err) {
    const mergeError = err instanceof Error ? err.message : "merge failed";
    // Record the failure BEFORE launching the fix session, so an identical repeat backs
    // off the NEXT cycle even if the fix session itself dies. Never throws (telemetry).
    await recordMergeFailure(
      { wsId: ws.wsId, projectId: ws.projectId, workingDir: ws.workingDir, issueNumber: ws.issueNumber },
      mergeError,
      backoff,
    );
    let fixOk = true;
    try {
      await workspaceActions.fixAndMerge(ws.wsId, mergeError);
    } catch {
      fixOk = false;
    }
    console.log(logs.conflictMsg);
    logAction("merge", ws.wsId, ws.issueId, {
      endpoint: `POST /api/workspaces/${ws.wsId}/fix-and-merge`,
      responseSummary: mergeError.slice(0, 200),
      verificationResult: fixOk ? "ok" : "failed",
    });
  }
}

/**
 * Closes a direct workspace and moves its issue to Done. The caller keeps the
 * status-specific console.log and the board broadcast at the call site.
 */
export async function closeDirectWorkspaceAsDone(ws: WorkspaceCandidate, logAction: LogMonitorActionFn): Promise<void> {
  const now = new Date().toISOString();
  // #547: the documented close transition, so this stamps `closedAt` like every other close.
  // `markMerged: false` — a direct workspace lands on the branch it is already on; there is
  // no merge to record.
  await closeWorkspace({ database: db, workspaceId: ws.wsId, now, markMerged: false });
  // #226 — mirror column, cleared through the helper that also updates the leading repos row.
  // NOT `closeWorkspace({ clearWorkingDir: true })`, which nulls the workspace column only
  // and would leave the repos row pointing at a directory that is about to be removed.
  await clearWorkspaceWorkingDir(ws.wsId, now, db);
  const doneStatusId = await getProjectStatusIdByName(ws.projectId, "Done");
  if (doneStatusId) await transitionIssueStatus(db, ws.issueId, doneStatusId, { now }).catch((err) => console.warn(`[monitor] failed to move direct-workspace issue ${ws.issueId} to Done:`, errorMessage(err)));
  logAction("merge", ws.wsId, ws.issueId, { verificationResult: "ok" });
}
