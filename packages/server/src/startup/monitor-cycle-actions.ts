import { transitionIssueStatus } from "@agentic-kanban/shared/lib/workflow-engine";
import { projectStatuses } from "@agentic-kanban/shared/schema";
import { sql } from "drizzle-orm";
import { db } from "../db/index.js";
import type { MonitorActionName } from "../services/monitor-nudge.js";
import type { MonitorAction } from "./monitor-helpers.js";
import type { WorkspaceCandidate } from "./monitor-cycle.js";
import type { MonitorWorkspaceActions } from "./monitor-workspace-actions.js";
import { RUN_GATE, resolveMergeGateShas, type MergeGateToken } from "../services/pre-merge-gate.service.js";
import { runGateWithEvidence } from "../services/merge-gate-evidence.js";
import type { BoardEventType } from "../services/board-events.js";
import { clearWorkspaceWorkingDir } from "../repositories/workspace-crud.repository.js";
import { clearMergeBackoff, recordMergeFailure, type MergeBackoffDeps } from "../services/merge-backoff.service.js";
import { errorMessage } from "@agentic-kanban/shared/lib/error-message";
import { closeWorkspace } from "../services/workspace-lifecycle-reconcile.service.js";
import { reconcileGroupMemberIssues } from "../services/merge-cleanup.service.js";
import { isPreMergeGateFailure } from "../services/workspace-merge-gate.js";
import {
  clearFailedGate,
  clearGateInFlight,
  getLastFailedGate,
  isGateInFlight,
  markGateInFlight,
  recordFailedGate,
} from "../services/monitor-gate-recall.js";

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
    // #638: a RED verify gate is not a merge conflict, and routing it here converted every
    // gate failure into an ungated merge — fix-and-merge's prompt is entirely about
    // working-tree cleanliness (it never runs verify/build/tests), yet its exit-0 path merges
    // under `gateSkipExplicit`, a claim the prompt does not support. A gate timeout took the
    // same road, so a slow suite on a loaded box was enough; no malice required.
    //
    // The merge queue already classifies this correctly ("a batch reconciler agent can't fix a
    // red verify script") — this is the monitor path adopting the same rule. The workspace
    // stays unmerged with its backoff recorded, which is the honest outcome: someone has to
    // make the tests pass.
    if (isPreMergeGateFailure(err)) {
      console.warn(
        `[monitor] merge withheld for workspace ${ws.wsId} by the pre-merge gate — NOT routing to fix-and-merge (#638): ${mergeError}`,
      );
      logAction("merge", ws.wsId, ws.issueId, {
        endpoint: `POST /api/workspaces/${ws.wsId}/merge`,
        responseSummary: `verify_failed (no fix-and-merge fallback): ${mergeError.slice(0, 160)}`,
        verificationResult: "failed",
      });
      return;
    }
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
  // Ticket group (#661): a closing group workspace lands every member ticket too.
  await reconcileGroupMemberIssues({ database: db, workspaceId: ws.wsId, now, projectId: ws.projectId });
  logAction("merge", ws.wsId, ws.issueId, { verificationResult: "ok" });
}

/** Outcome of {@link resolveReviewingStoppedGateToken}. */
export type ReviewingStoppedGateOutcome =
  | { kind: "token"; token: MergeGateToken }
  | { kind: "skip" };

/**
 * Decide the merge-gate token for a NOT-ready reviewing+stopped candidate (#1161), reusing
 * the monitor's own memory of gate verdicts it produced (`monitor-gate-recall.ts`) instead of
 * blindly re-running the gate every cycle.
 *
 * A candidate whose gate genuinely FAILED sits at the head of every later cycle's walk exactly
 * as it did this one — nothing about it changed — so re-gating it is pure waste that starves
 * every OTHER candidate behind it (measured: 20 of 27 verify-chain lines over ~2h were the same
 * red workspace). Only the branch moving (new commit / rebase) earns it another run.
 *
 * A second guard covers the companion failure: an earlier cycle's gate for this SAME workspace
 * may still be running — it was ABANDONED on `candidateTimeoutMs` (the wait gave up, not the
 * work; a JS promise cannot be cancelled), so a naive re-walk would start a SECOND chain on top
 * of the first. `{kind: "skip"}` covers both guards; the caller must take no further action.
 */
export async function resolveReviewingStoppedGateToken(
  ws: WorkspaceCandidate,
  projectId: string,
  boardEventsBroadcast: (projectId: string, event: BoardEventType) => void,
  emitMergeFailedEvent: (gate: { stage: string; message: string }) => void,
): Promise<ReviewingStoppedGateOutcome> {
  const gateWorkspace = { id: ws.wsId, workingDir: ws.workingDir, baseBranch: ws.baseBranch };

  const currentShas = await resolveMergeGateShas(gateWorkspace).catch(() => ({}) as Awaited<ReturnType<typeof resolveMergeGateShas>>);
  const remembered = getLastFailedGate(ws.wsId);
  if (remembered && currentShas.branchSha && remembered.branchSha === currentShas.branchSha) {
    console.log(`[monitor] Skipping re-gate for reviewing+stopped workspace ${ws.wsId}  gate already failed at this sha (${remembered.branchSha.slice(0, 8)}) on ${remembered.failedAt}; unchanged since`);
    return { kind: "skip" };
  }

  if (isGateInFlight(ws.wsId)) {
    console.log(`[monitor] Skipping reviewing+stopped workspace ${ws.wsId}  a monitor gate is already in flight for it (abandoned by a previous cycle's timeout, still running)`);
    return { kind: "skip" };
  }

  markGateInFlight(ws.wsId);
  let gate: Awaited<ReturnType<typeof runGateWithEvidence>>;
  try {
    gate = await runGateWithEvidence({
      workspace: gateWorkspace,
      projectId,
      source: "monitor-cycle gate (reviewing+stopped)",
      database: db,
    });
  } finally {
    clearGateInFlight(ws.wsId);
  }
  if (!gate.passed) {
    console.log(`[monitor] Withholding merge for reviewing+stopped workspace ${ws.wsId}  pre-merge gate failed (${gate.stage}): ${gate.message}`);
    if (gate.shasBefore.branchSha) {
      recordFailedGate(ws.wsId, { branchSha: gate.shasBefore.branchSha, failedAt: gate.ranAt, message: gate.message });
    }
    emitMergeFailedEvent({ stage: gate.stage, message: gate.message });
    boardEventsBroadcast(projectId, "workflow_error");
    return { kind: "skip" };
  }
  clearFailedGate(ws.wsId);
  return { kind: "token", token: gate.token ?? RUN_GATE };
}
