import { transitionIssueStatus } from "@agentic-kanban/shared/lib/workflow-engine";
import { projectStatuses, sessions } from "@agentic-kanban/shared/schema";
import { and, eq, sql } from "drizzle-orm";
import { db } from "../db/index.js";
import type { MonitorActionName } from "../services/monitor-nudge.js";
import { emitButlerSystemEvent } from "../services/butler-event-feed.js";
import { isReviewLaunchPending, startManualReview } from "../services/review.service.js";
import type { MonitorAction } from "./monitor-helpers.js";
import type { ProcessWorkspaceDeps, WorkspaceCandidate } from "./monitor-cycle.js";
import type { MonitorWorkspaceActions } from "./monitor-workspace-actions.js";
import { gateAlreadyPassed, RUN_GATE, resolveMergeGateShas, type MergeGateEvidence, type MergeGateToken } from "../services/pre-merge-gate.service.js";
import { runGateWithEvidence } from "../services/merge-gate-evidence.js";
import type { BoardEventType } from "../services/board-events.js";
import { clearWorkspaceWorkingDir } from "../repositories/workspace-crud.repository.js";
import { clearMergeBackoff, recordMergeFailure, shouldSkipMergeForBackoff, type MergeBackoffDeps } from "../services/merge-backoff.service.js";
import { errorMessage } from "@agentic-kanban/shared/lib/error-message";
import { closeWorkspace } from "../services/workspace-lifecycle-reconcile.service.js";
import { reconcileGroupMemberIssues } from "../services/merge-cleanup.service.js";
import { isPreMergeGateFailure, isLockContentionFailure, preMergeGateFailedSuites } from "../services/workspace-merge-gate.js";
import { escalateVerifyFailedSkip } from "../services/verify-failed-escalation.js";
import { resetGateRedFeedback } from "../services/gate-red-feedback.js";
import { logMonitorLockContentionSkip } from "../services/merge-lock-contention.js";
import { getMergeRun } from "../repositories/merge-run.repository.js";
import { peekMergeJob } from "../services/merge-job.service.js";
import { consecutiveBlockingReviewSessions, type ReviewLoopSessionRow } from "../services/monitor-cycle-rules.js";
import {
  clearFailedGate,
  clearGateInFlight,
  getLastFailedGate,
  isGateInFlight,
  markGateInFlight,
  recordFailedGate,
} from "../services/monitor-gate-recall.js";
import type { AutoMergeSource } from "@agentic-kanban/shared/lib/merge-policy";

export type LogMonitorActionFn = (action: MonitorActionName, workspaceId: string, issueId: string, extra?: Pick<MonitorAction, "endpoint" | "httpStatus" | "responseSummary" | "verificationResult">) => void;

/** Shared per-cycle state handed to the per-status handlers. `stats` is the
 * SAME mutable object the cap closures read, so cap-check-before-action math
 * is unchanged by the decomposition. */
export type CycleContext = {
  deps: ProcessWorkspaceDeps;
  stats: { relaunched: number; merged: number; nudged: number };
  logAction: LogMonitorActionFn;
  canStartRelaunch: (ws: WorkspaceCandidate) => boolean;
  canStartMerge: (ws: WorkspaceCandidate) => boolean;
  stuckBuilderTimeoutMs: number;
};

/**
 * Build the merge-gate DECISION token for a `readyForMerge` workspace from the REAL evidence
 * persisted when the gate last ran (exit-workflow, at review-exit) — NOT a freshly fabricated
 * `ranAt: new Date()` (#182), which would make `resolveMergeGate`'s 15-min staleness guard
 * unable to ever fire on this path. No persisted evidence (never gated, e.g. a manual
 * `POST /workspaces/:id/ready-for-merge`) forces a real gate run via `RUN_GATE`.
 */
export function gateTokenFromWorkspaceEvidence(ws: WorkspaceCandidate, source: string): MergeGateToken {
  if (ws.mergeGateRanAt && ws.mergeGateStage) {
    // Carry the recorded tips (0108) so `resolveMergeGate` can validate the pass by CONTENT.
    // Without them a pass that is merely old is re-gated (a wasted full suite + build) and a
    // pass whose base has since moved is trusted purely because it looks recent.
    return gateAlreadyPassed({
      ranAt: ws.mergeGateRanAt,
      stage: ws.mergeGateStage as MergeGateEvidence["stage"],
      source,
      branchSha: ws.mergeGateBranchSha ?? undefined,
      baseSha: ws.mergeGateBaseSha ?? undefined,
    });
  }
  return RUN_GATE;
}

/** Build the #417 backoff deps from the cycle deps: injected seams win; the monitor's
 *  clock seam and board broadcaster are threaded through so tests stay deterministic
 *  and the drive-obstacle warning reaches live clients. */
export function mergeBackoffDeps(deps: ProcessWorkspaceDeps): MergeBackoffDeps {
  return {
    now: deps.now ? () => new Date(deps.now!()) : undefined,
    broadcast: (projectId, reason) => deps.boardEvents.broadcast(projectId, reason),
    ...deps.mergeBackoff,
  };
}

/**
 * #417 circuit breaker: when this workspace's previous merge/fix-and-merge attempt failed
 * and the IDENTICAL failure is still inside its (exponentially growing) backoff window,
 * skip the attempt entirely — BEFORE the per-cycle merge slot is consumed and before any
 * expensive gate/verify work. A relevant state change (new commit, main checkout clean,
 * verify script changed) clears the block inside `shouldSkipMergeForBackoff` itself.
 */
export async function mergeBlockedByBackoff(ws: WorkspaceCandidate, deps: ProcessWorkspaceDeps): Promise<boolean> {
  const decision = await shouldSkipMergeForBackoff(
    { wsId: ws.wsId, projectId: ws.projectId, workingDir: ws.workingDir, issueNumber: ws.issueNumber },
    mergeBackoffDeps(deps),
  ).catch(() => ({ skip: false as const, reason: undefined }));
  if (decision.skip) {
    console.log(`[monitor] Skipping merge for workspace ${ws.wsId} (issue #${ws.issueNumber ?? "?"}) — ${decision.reason}`);
    return true;
  }
  return false;
}

/**
 * #932 — an idle, In-Review, not-ready workspace whose builder FINISHED cleanly but was never
 * reviewed. Before this the cycle only logged "skipping relaunch … is in review" and moved on,
 * so the sole recovery was the 60s stranded-review sweep; when that sweep was held (or the
 * builder exit's own auto-review launch never fired) the workspace sat idle indefinitely.
 * Observed live: #905/#926/#927 all exited 0 with commits on their branch and were picked up by
 * nothing until a hand-fired `POST /:id/review`.
 *
 * Deliberately NOT gated on the build semaphore: a review is an agent session, not a
 * build/verify invocation, so `buildGateBusy()` has no claim on it — that semaphore governs
 * backend-spawned build load, and holding reviews behind it is what let one long gate freeze
 * every project's non-gate progress.
 *
 * Returns true when a review was launched (the caller then stops handling this candidate).
 */
async function launchStrandedReview(ws: WorkspaceCandidate, ctx: CycleContext): Promise<boolean> {
  const { deps, logAction } = ctx;
  if (ws.isDirect || !ws.workingDir || !ws.baseBranch) return false;
  // Another path (exit-workflow auto-review, manual review, the reconciler) is mid-launch —
  // its session row may not exist yet, so the query below cannot see it (#270).
  if (isReviewLaunchPending(ws.wsId)) return false;
  // Only the never-reviewed shape belongs here. A workspace that HAS been reviewed but was
  // never armed is the reconciler's shape 2 (#932) — it owns that repair, and duplicating
  // the arming here would mean two paths racing to write the same flag.
  const priorReview = await db.select({ id: sessions.id }).from(sessions)
    .where(and(eq(sessions.workspaceId, ws.wsId), eq(sessions.triggerType, "review"))).limit(1);
  if (priorReview.length > 0) return false;
  try {
    const { sessionId } = await (deps.startReview ?? startManualReview)(db, () => deps.sessionManager, deps.boardEvents, deps.reviewSessionIds, ws.wsId, false);
    logAction("mark_idle", ws.wsId, ws.issueId, {
      endpoint: `POST /api/workspaces/${ws.wsId}/review`,
      responseSummary: `Launched review for unreviewed In-Review workspace (session ${sessionId})`,
      verificationResult: "ok",
    });
    console.log(`[monitor] Launched review for idle unreviewed In-Review workspace ${ws.wsId} (issue #${ws.issueNumber ?? "?"}) session=${sessionId}`);
    deps.boardEvents.broadcast(ws.projectId, "board_changed");
    return true;
  } catch (err) {
    console.warn(`[monitor] Failed to launch review for idle In-Review workspace ${ws.wsId}:`, errorMessage(err));
    return false;
  }
}

/**
 * The idle + issue-is-"In Review" arm, extracted from `handleIdleWorkspace` (#932).
 *
 * Two dispositions, and until #932 only the first existed:
 *  - `auto_merge_in_review` ON  — gate and land the un-ready work (#821).
 *  - otherwise                  — if it was never reviewed, REVIEW it; only then log and wait.
 *    The bare log was the whole behaviour before, which is why three finished workspaces sat
 *    idle across cycles with nothing to move them.
 */
export async function handleIdleInReviewWorkspace(ws: WorkspaceCandidate, ctx: CycleContext): Promise<void> {
  const { deps, logAction, canStartMerge } = ctx;
  if (!(deps.monitorOwnsMerge && deps.autoMergeInReview && !deps.autoMergeDisabledProjectIds?.has(ws.projectId))) {
    if (await launchStrandedReview(ws, ctx)) return;
    console.log(`[monitor] Skipping relaunch for idle workspace ${ws.wsId}  issue #${ws.issueNumber} is in review (committed work awaiting merge; enable auto_merge_in_review to land it)`);
    return;
  }
  // #417: the backoff check runs BEFORE the pre-merge gate below — the gate is the
  // expensive verify/smoke run this circuit breaker exists to stop repeating.
  if (await mergeBlockedByBackoff(ws, deps)) return;
  // #821: the auto_merge_in_review path merges idle In-Review workspaces that are NOT
  // readyForMerge. The verify_script + smoke quality gate lived ONLY in the review-exit handler,
  // so this path bypassed it entirely — unverified/un-rendered code merged on hands-off projects.
  // Run the shared pre-merge gate HERE before merging un-ready work; on failure, WITHHOLD the
  // merge (leave In Review + log) rather than silently land it. (Work the review already approved
  // — readyForMerge=true — has passed the gate at review-exit, so skip the re-run for it.)
  // Build the explicit merge-gate PROOF token (arch-review §1.2): either the gate we run
  // right here for un-ready work, or the review-exit gate that set readyForMerge.
  let gateToken: MergeGateToken = gateTokenFromWorkspaceEvidence(ws, "review-exit gate (readyForMerge, auto_merge_in_review)");
  if (!ws.readyForMerge) {
    // #540/#573: the #243 protocol via its ONE owner — pin the state the gate is ABOUT to
    // test, run, re-pin, and mint proof only for a tip that did not move. Evidence minted
    // WITHOUT tips falls back to `evidenceIsValid`'s 15-minute age check with a `ranAt`
    // stamped at gate END, so a commit landing mid-gate produced evidence that looked FRESH
    // and the moved tip merged having never been tested.
    const gateWorkspace = { id: ws.wsId, workingDir: ws.workingDir, baseBranch: ws.baseBranch };
    const gate = await runGateWithEvidence({
      workspace: gateWorkspace,
      projectId: ws.projectId,
      source: "monitor-cycle gate (auto_merge_in_review)",
      database: db,
    });
    if (!gate.passed) {
      console.log(`[monitor] Withholding auto_merge_in_review for idle In-Review workspace ${ws.wsId}  pre-merge gate failed (${gate.stage}): ${gate.message}`);
      emitButlerSystemEvent({
        projectId: ws.projectId,
        kind: "merge_failed",
        workspaceId: ws.wsId,
        issueNumber: ws.issueNumber ?? undefined,
        text: `Held idle In-Review workspace ${ws.wsId} (issue #${ws.issueNumber ?? "?"}): pre-merge gate failed (${gate.stage}). ${gate.message.slice(0, 300)}`,
      });
      deps.boardEvents.broadcast(ws.projectId, "workflow_error");
      return;
    }
    if (gate.ran) console.log(`[monitor] Pre-merge gate passed for idle In-Review workspace ${ws.wsId} (${gate.stage}); proceeding with auto_merge_in_review`);
    // Null when a tip moved during the run (or nothing was gated) — then the merge executor
    // gates for itself rather than being handed proof for a state that no longer exists.
    gateToken = gate.token ?? RUN_GATE;
  }
  if (!canStartMerge(ws)) return;
  await mergeWorkspaceWithFixFallback(ws, deps.workspaceActions, logAction, {
    conflictMsg: `[monitor] Merge conflict for idle In-Review workspace ${ws.wsId} (auto_merge_in_review)  triggered fix-and-merge`,
    successMsg: `[monitor] Auto-merged idle In-Review workspace ${ws.wsId} (auto_merge_in_review, not marked ready)`,
  }, gateToken, mergeBackoffDeps(deps));
  deps.boardEvents.broadcast(ws.projectId, "board_changed");
}

/**
 * Why the monitor is leaving an idle+readyForMerge (or reviewing+stopped) workspace alone
 * instead of merging it (#1255). `monitorOwnsMerge=false` is NOT synonymous with "auto-merge is
 * disabled": under `merge_strategy=merge_queue` with the global `auto_merge` pref ON, the queue
 * — not the monitor — owns landing reviewed work, and reporting that as "disabled" reads as an
 * outage to an operator watching board.log, who then merges by hand and duplicates a job the
 * queue already has in flight. `source` (from `resolveAutoMerge`) names the real reason; absent
 * (an older/simpler test double) falls back to the generic wording this message used to have.
 */
export function describeSkippedAutoMerge(source: AutoMergeSource | undefined): string {
  switch (source) {
    case "enabled":
      // monitorOwnsMerge is false yet the effective owner is "enabled" only when the owner is
      // the merge queue (owner !== "monitor" but not off/direct/disabled) — the queue owns it.
      return "left to the merge queue (merge_strategy=merge_queue)";
    case "direct_strategy":
      return "auto-merge off (direct_strategy: merge_strategy=direct reserves merging for a human)";
    case "project_disabled":
      return "auto-merge off (project_disabled: auto_merge_disabled is set for this project)";
    case "global_off":
      return "auto-merge off (global_off: the auto_merge preference is off)";
    default:
      return "auto_merge is disabled";
  }
}

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
    resetGateRedFeedback(ws.wsId);
    console.log(logs.successMsg);
    logAction("merge", ws.wsId, ws.issueId, {
      endpoint: `POST /api/workspaces/${ws.wsId}/merge`,
      verificationResult: "ok",
    });
  } catch (err) {
    const mergeError = err instanceof Error ? err.message : "merge failed";
    // #1151: lock contention is checked, and returned on, BEFORE the backoff bookkeeping
    // below. `recordMergeFailure` classifies by message signature with digits stripped, so
    // repeated contention against the same holder class (e.g. a merge train) hashes to an
    // IDENTICAL signature — recording it would ramp the exponential backoff and eventually
    // fire a false `merge_retry_blocked` obstacle for a merge that never even started. The
    // repo lock's own wait/retry loop already governs when this workspace tries again; the
    // monitor-level backoff must not also throttle it.
    if (isLockContentionFailure(err)) {
      logMonitorLockContentionSkip({ wsId: ws.wsId, issueId: ws.issueId, mergeError, logAction });
      return;
    }
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
      // #1293: the red goes back to the builder (one turn per head, capped), and only escalates
      // once the cap is spent. The backoff row was written above, so it is not written twice.
      const { failedSuites, guardFailure } = preMergeGateFailedSuites(err);
      const sendTurn = workspaceActions.sendTurn?.bind(workspaceActions);
      await escalateVerifyFailedSkip({
        workspaceId: ws.wsId,
        projectId: ws.projectId,
        workingDir: ws.workingDir,
        issueNumber: ws.issueNumber,
        reason: `verify_failed: ${mergeError}`,
        failedSuites,
        guardFailure,
      }, {
        database: backoff?.database ?? db,
        broadcast: backoff?.broadcast,
        sendBuilderTurn: sendTurn,
        backoffRecorded: true,
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

/**
 * #1259: true while a gate/merge job is running for this workspace right now — checked by the
 * review-loop breaker so it never closes a workspace mid-merge (a closed workspace is invisible
 * to the merge queue, so this would strand a reviewed, gated branch until a hand reopen).
 * `getMergeRun` is the durable cross-restart marker (`workspace_merge_run`, deleted on every
 * terminal transition); `peekMergeJob` is the in-process job tracker's display-only reader (no
 * zombie self-heal side effect, which is what a passive check wants); `isGateInFlight` is the
 * monitor's own "gate already running for this workspace" flag used above by
 * `resolveReviewingStoppedGateToken`.
 */
async function isMergeOrGateInFlight(workspaceId: string): Promise<boolean> {
  if (isGateInFlight(workspaceId)) return true;
  if (peekMergeJob(workspaceId)?.state === "running") return true;
  return (await getMergeRun(workspaceId)) !== undefined;
}

/**
 * #1259: the review-loop breaker's actual trigger, once the caller has already checked
 * `sessionCount >= 5`, `issueStatusName === "In Review"` and `!readyForMerge`. Requires at
 * least 5 CONSECUTIVE review sessions that each ended with a blocking finding — a build, a
 * chat turn, or one clean review anywhere in the recent history means this is progress, not a
 * loop — and additionally never fires while a gate/merge job is in flight for this workspace
 * (closing it then would strand a branch the merge queue can no longer see, exactly what
 * happened to #1256).
 */
export async function reviewLoopBreakerShouldFire(ws: WorkspaceCandidate, recentSessionRows: ReviewLoopSessionRow[]): Promise<boolean> {
  if (consecutiveBlockingReviewSessions(recentSessionRows).length < 5) return false;
  return !(await isMergeOrGateInFlight(ws.wsId));
}
