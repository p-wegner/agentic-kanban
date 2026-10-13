/**
 * Re-drive the exit workflow for committed work that stalled In Progress (#1439).
 *
 * The board's step after a builder ends — the implement-exit check, then review — hangs off an
 * in-memory exit event. Two shapes lose it:
 *
 *  - a builder is killed (the 900s hang watchdog, a crash) AFTER it pushed commits: the exit is
 *    non-zero, so it was routed to "failed" and nothing ran the check;
 *  - the board restarts while the check (or the recheck after a feedback turn) is queued for the
 *    verify slot: the queue, the in-flight mark and the retry count all lived in memory.
 *
 * Both leave an `idle` workspace under an In Progress issue with no running session, which the
 * monitor reads as "a builder to relaunch" at best. This sweep finds that shape, and when the branch
 * has commits ahead of base it replays the builder-exit workflow as an exit that ENDED WITH WORK —
 * the same entry point a real exit uses, so the check, the feedback turn cap, the review launch and
 * the attention mark all behave exactly as they would have. Workspaces with no commits are left to
 * the monitor's relaunch path (logged, not touched).
 *
 * Crash-safe and idempotent: a re-drive that ends green moves the issue to In Review, red sends a
 * feedback turn (a running session) or marks attention (`blocked`) — none of which is a candidate
 * next pass. A per-workspace cooldown bounds the case where the re-drive itself changes nothing.
 */
import type { Database } from "../db/index.js";
import { listIdleInProgressWorkspaces, type StalledInProgressCandidate } from "../repositories/stalled-in-progress.repository.js";
import { workspaceHasCommittedWork } from "../services/workspace-commits.js";
import { implementExitHoldReason } from "../services/implement-exit-check-state.js";
import { getMergeJob } from "../services/merge-job.service.js";
import { isReviewLaunchPending } from "../services/review.service.js";
import { errorMessage } from "@agentic-kanban/shared/lib/error-message";
import { startPeriodicSweep, type PeriodicSweepHandle } from "../lib/periodic-sweep.js";

/** A session must have been over this long before the sweep acts: the live exit path gets first go. */
export const STALLED_GRACE_MS = 3 * 60_000;
/** The same workspace is re-driven at most once per window, whatever the re-drive achieved. */
export const REDRIVE_COOLDOWN_MS = 10 * 60_000;

const NON_BUILDER_TRIGGERS = new Set(["review", "fix-and-merge", "fix-conflicts", "learning", "verify", "bisect"]);

const lastRedriveMs = new Map<string, number>();

export type StalledDecision = { redrive: true } | { redrive: false; reason: string };

/** DECISION (pure): is this candidate a builder exit nobody drove? Commits are checked by the caller. */
export function decideStalledInProgress(c: StalledInProgressCandidate, nowMs: number): StalledDecision {
  if (c.parentWorkspaceId || c.forkStatus) return { redrive: false, reason: "fork child (its join consolidates it)" };
  if (c.planMode) return { redrive: false, reason: "plan-mode workspace" };
  if (c.hasRunningSession) return { redrive: false, reason: "a session is running" };
  if (!c.lastSessionId || !c.lastSessionEndedAt) return { redrive: false, reason: "no ended session" };
  if (c.lastSessionTriggerType && NON_BUILDER_TRIGGERS.has(c.lastSessionTriggerType)) {
    return { redrive: false, reason: `last session was a ${c.lastSessionTriggerType} session` };
  }
  if (!c.workingDir || !c.baseBranch) return { redrive: false, reason: "no worktree/base to diff" };
  const endedMs = Date.parse(c.lastSessionEndedAt);
  if (Number.isFinite(endedMs) && nowMs - endedMs < STALLED_GRACE_MS) return { redrive: false, reason: "session ended moments ago" };
  const last = lastRedriveMs.get(c.workspaceId);
  if (last !== undefined && nowMs - last < REDRIVE_COOLDOWN_MS) return { redrive: false, reason: "re-driven recently" };
  return { redrive: true };
}

export interface StalledInProgressDeps {
  database: Database;
  /** `runWorkflowOnExit` of the workflow engine: replays the builder exit for a session. */
  runWorkflowOnExit: (workspaceId: string, sessionId: string, exitCode: number | null, wasPlanMode?: boolean) => Promise<unknown>;
  hasCommittedWork?: (workspace: { id: string; workingDir: string | null; baseBranch: string | null }) => Promise<boolean>;
  nowMs?: number;
}

export async function reconcileStalledInProgress(deps: StalledInProgressDeps): Promise<number> {
  const database = deps.database;
  const nowMs = deps.nowMs ?? Date.now();
  const hasWork = deps.hasCommittedWork
    ?? ((ws) => workspaceHasCommittedWork({ ...ws, isDirect: false }, null, database, { onUnknown: false }));

  let redriven = 0;
  for (const c of await listIdleInProgressWorkspaces(database)) {
    const decision = decideStalledInProgress(c, nowMs);
    if (!decision.redrive) continue;
    // The check is running (or queued for the verify slot) in THIS process, or the board marked it.
    if (implementExitHoldReason(c.workspaceId)) continue;
    if (getMergeJob(c.workspaceId)?.state === "running" || isReviewLaunchPending(c.workspaceId)) continue;
    const committed = await hasWork({ id: c.workspaceId, workingDir: c.workingDir, baseBranch: c.baseBranch }).catch(() => false);
    // No commits: the monitor's relaunch path owns it; logging every pass would only be noise.
    if (!committed) continue;
    lastRedriveMs.set(c.workspaceId, nowMs);
    console.log(
      `[stalled-in-progress] #${c.issueNumber ?? "?"} workspace ${c.workspaceId}: In Progress with commits ahead of base, ` +
        `no running session, no pending check (last session ${c.lastSessionId} ended ${c.lastSessionEndedAt}) — re-driving the exit check`,
    );
    try {
      // Exit code 0: the session ended WITH WORK, whatever killed it.
      await deps.runWorkflowOnExit(c.workspaceId, c.lastSessionId!, 0, false);
      redriven++;
    } catch (err) {
      console.warn(`[stalled-in-progress] re-drive of workspace ${c.workspaceId} failed: ${errorMessage(err)}`);
    }
  }
  return redriven;
}

const DEFAULT_INTERVAL_MS = 2 * 60_000;
let activeSweep: PeriodicSweepHandle | null = null;

export function stopStalledInProgressReconciler(): void {
  activeSweep?.stop();
  activeSweep = null;
}

/** Runs shortly after boot (the restart-while-queued case) and then on an interval. */
export function startStalledInProgressReconciler(deps: StalledInProgressDeps, intervalMs = DEFAULT_INTERVAL_MS): PeriodicSweepHandle {
  stopStalledInProgressReconciler();
  activeSweep = startPeriodicSweep({
    name: "stalled-in-progress",
    tick: () => reconcileStalledInProgress(deps),
    bootDelayMs: 20_000,
    intervalMs,
  });
  return activeSweep;
}

/** Test seam. */
export function resetStalledInProgressStateForTests(): void {
  lastRedriveMs.clear();
}
