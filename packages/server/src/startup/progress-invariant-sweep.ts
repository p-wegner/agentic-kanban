/**
 * The progress-invariant sweep (#1561): every open ticket of a monitor-driven project must have a
 * live driver. The verdict is `services/progress-invariant.ts` (pure); this file gathers the
 * snapshot, applies the generic recovery for the state the ticket is in, and reports a PassReport.
 *
 * A ticket with no driver past its budget is logged as
 * `[progress-invariant] #N has no driver since <t>: <last known state>`, recorded as a board health
 * event (the console's ATTENTION feed), recovered ONCE per hour (cancel an orphaned gate job, clear
 * a backoff from a stale sha, re-drive the exit check, relaunch review, send the builder a follow-up
 * turn), and then escalated to `needs_attention` (workspace `blocked`) if that did not restore one.
 *
 * Recovery state is in-memory on purpose, like the other sweeps: after a restart the worst case is
 * one more recovery attempt, which the verdict itself keeps idempotent.
 */
import type { Database } from "../db/index.js";
import { db } from "../db/index.js";
import { toPrefMap } from "@agentic-kanban/shared/lib/preference-map";
import { revParse } from "@agentic-kanban/shared/lib/git-service";
import { getAllPreferencesCached } from "../repositories/preferences.repository.js";
import { listOpenTicketRows, type OpenTicketRow } from "../repositories/progress-invariant.repository.js";
import { listActiveMergeTrainsForProject } from "../repositories/merge-train.repository.js";
import { clearMergeBackoffState } from "../repositories/merge-backoff.repository.js";
import { setWorkspaceStatus } from "../repositories/workspace-status.repository.js";
import { logBoardHealthEvent } from "../repositories/board-health-events.repository.js";
import { monitorDrivenProjectIds } from "../services/start-policy.service.js";
import { workspaceHasCommittedWork } from "../services/workspace-commits.js";
import { implementExitHoldReason } from "../services/implement-exit-check-state.js";
import { isReviewLaunchPending } from "../services/review.service.js";
import { peekMergeJob, cancelMergeJob } from "../services/merge-job.service.js";
import {
  decideRecoveryStep,
  decideTicketDriver,
  type RecoveryAction,
  type RecoveryState,
  type StageName,
  type TicketDriverSnapshot,
} from "../services/progress-invariant.js";
import { emptyPassReport, formatPassReportBody, recordActed, recordSkipped, type PassReport } from "../lib/pass-report.js";
import { startPeriodicSweep, type PeriodicSweepHandle } from "../lib/periodic-sweep.js";
import { errorMessage } from "@agentic-kanban/shared/lib/error-message";

/** What the sweep can DO about a violation. Each member is optional so a missing channel degrades to escalation. */
export interface ProgressRecoveryPort {
  cancelGateJob(workspaceId: string, reason: string): Promise<void> | void;
  clearBackoff(workspaceId: string): Promise<void>;
  redriveExitCheck(workspaceId: string): Promise<void>;
  relaunchReview(workspaceId: string): Promise<void>;
  followUpBuilder(workspaceId: string, content: string): Promise<void>;
  /** Mark the ticket `needs_attention` and record why. */
  escalate(snapshot: TicketDriverSnapshot, why: string): Promise<void>;
}

export interface ProgressInvariantReport extends PassReport {
  /** Issue numbers (or workspace ids) that were violations this pass. */
  violations: string[];
  recovered: string[];
  escalated: string[];
}

export interface ProgressInvariantDeps {
  database?: Database;
  /** Snapshot source; defaults to the DB + in-process merge-job registry. */
  loadSnapshots?: (nowMs: number) => Promise<TicketDriverSnapshot[]>;
  recovery: ProgressRecoveryPort;
  nowMs?: number;
  log?: (message: string) => void;
}

const recoveryState = new Map<string, RecoveryState>();

/** The prompt a builder that exited with no commit gets (generic: it does not guess why it stopped). */
export const NO_COMMIT_FOLLOWUP_PROMPT =
  "Your session ended without any commit on this branch, and the board still needs a result. " +
  "If the work is finished, commit it now. If you were waiting on background work, wait for it inside this turn " +
  "(do not end the turn while it runs), then commit. If you are blocked, say exactly what blocks you.";

function stageOf(name: string): StageName {
  if (name === "In Progress") return "in_progress";
  if (name === "In Review") return "in_review";
  return "other";
}

async function loadDefaultSnapshots(database: Database, nowMs: number): Promise<TicketDriverSnapshot[]> {
  void nowMs;
  const prefMap = toPrefMap(await getAllPreferencesCached(database));
  const projectIds = [...monitorDrivenProjectIds(prefMap)];
  const rows = await listOpenTicketRows(projectIds, database);
  const trainMembers = new Map<string, Set<string>>();
  for (const projectId of projectIds) {
    const trains = await listActiveMergeTrainsForProject(projectId, ["assembling", "gating"], database);
    const members = new Set<string>();
    for (const t of trains) {
      try {
        for (const id of JSON.parse(t.memberWorkspaceIds) as string[]) members.add(id);
      } catch { /* unparseable membership: treat as no members */ }
    }
    trainMembers.set(projectId, members);
  }
  const snapshots: TicketDriverSnapshot[] = [];
  for (const r of rows) {
    // Forks and plan-mode workspaces are driven by their join / the plan reconciler, not by this invariant.
    if (r.parentWorkspaceId || r.planMode) continue;
    snapshots.push(await toSnapshot(r, trainMembers.get(r.projectId), database));
  }
  return snapshots;
}

async function toSnapshot(r: OpenTicketRow, members: Set<string> | undefined, database: Database): Promise<TicketDriverSnapshot> {
  const job = peekMergeJob(r.workspaceId);
  const openAttempt = job ? [...job.attempts].reverse().find((a) => !a.finishedAt) : undefined;
  let hasCommits: boolean | null = null;
  if (r.workingDir && r.baseBranch) {
    hasCommits = await workspaceHasCommittedWork(
      { id: r.workspaceId, workingDir: r.workingDir, baseBranch: r.baseBranch, isDirect: false },
      null,
      database,
      { onUnknown: false },
    ).catch(() => null);
  }
  let branchHeadSha: string | null = null;
  if (r.backoff?.branchSha && r.workingDir) branchHeadSha = await revParse(r.workingDir, "HEAD").then((s) => s.trim()).catch(() => null);
  return {
    issueNumber: r.issueNumber,
    workspaceId: r.workspaceId,
    projectId: r.projectId,
    stage: stageOf(r.stageName),
    workspaceStatus: r.workspaceStatus,
    readyForMerge: r.readyForMerge,
    workspaceUpdatedAt: r.workspaceUpdatedAt,
    hasRunningSession: r.hasRunningSession,
    lastSessionEndedAt: r.lastSessionEndedAt,
    lastSessionTriggerType: r.lastSessionTriggerType,
    hasCommits,
    exitWorkPending: isReviewLaunchPending(r.workspaceId) || implementExitHoldReason(r.workspaceId) !== null,
    mergeJob: job
      ? {
          state: job.state,
          lastActivityAt: job.lastActivityAt,
          phase: openAttempt ? (openAttempt.phase ?? "queued") : null,
          phaseDetail: openAttempt?.phaseDetail ?? null,
        }
      : null,
    backoff: r.backoff,
    branchHeadSha,
    inActiveTrain: members?.has(r.workspaceId) ?? false,
    hold: r.mergeHeld ? "merge-hold" : r.blockedByUnresolved ? "blocked-by" : null,
  };
}

async function applyRecovery(
  action: RecoveryAction,
  s: TicketDriverSnapshot,
  recovery: ProgressRecoveryPort,
): Promise<void> {
  switch (action) {
    case "cancel-gate-job":
      await recovery.cancelGateJob(s.workspaceId, "progress invariant: the gate job had no live driver");
      return;
    case "clear-backoff":
      await recovery.clearBackoff(s.workspaceId);
      return;
    case "redrive-exit-check":
      await recovery.redriveExitCheck(s.workspaceId);
      return;
    case "relaunch-review":
      await recovery.relaunchReview(s.workspaceId);
      return;
    case "followup-turn":
      await recovery.followUpBuilder(s.workspaceId, NO_COMMIT_FOLLOWUP_PROMPT);
      return;
    case "escalate":
      await recovery.escalate(s, "no generic recovery exists for this state");
      return;
  }
}

/** One pass of the invariant over every open ticket. */
export async function runProgressInvariantPass(
  deps: ProgressInvariantDeps,
): Promise<ProgressInvariantReport> {
  const nowMs = deps.nowMs ?? Date.now();
  const log = deps.log ?? ((m: string) => console.warn(`[progress-invariant] ${m}`));
  const snapshots = await (deps.loadSnapshots ?? ((n) => loadDefaultSnapshots(deps.database ?? db, n)))(nowMs);
  const report: ProgressInvariantReport = { ...emptyPassReport(snapshots.length), violations: [], recovered: [], escalated: [] };

  for (const s of snapshots) {
    const label = `#${s.issueNumber ?? s.workspaceId}`;
    const verdict = decideTicketDriver(s, nowMs);
    if (verdict.driven) {
      // A restored driver clears escalation (a human or the recovery fixed it) but keeps the
      // recovery timestamp, so "once per hour" survives a ticket that re-stalls.
      const state = recoveryState.get(s.workspaceId);
      if (state) state.escalated = false;
      recordSkipped(report, label, `driven: ${verdict.driver}`);
      continue;
    }
    report.violations.push(label);
    const state = recoveryState.get(s.workspaceId);
    const step = decideRecoveryStep(verdict, state, nowMs);
    if (step === "none" || step === "wait") {
      recordSkipped(report, label, `${verdict.shape}: ${step === "none" ? "already escalated" : "recovery in progress"}`);
      continue;
    }
    log(`${label} has no driver since ${verdict.since}: ${verdict.detail} [${verdict.shape} -> ${step === "escalate" ? "escalate" : verdict.recovery}]`);
    try {
      if (step === "escalate") {
        await deps.recovery.escalate(s, `${verdict.shape}: ${verdict.detail}`);
        recoveryState.set(s.workspaceId, { recoveredAtMs: state?.recoveredAtMs ?? nowMs, escalated: true });
        report.escalated.push(label);
        recordActed(report, label, `${verdict.shape}: escalated`);
      } else {
        await applyRecovery(verdict.recovery, s, deps.recovery);
        recoveryState.set(s.workspaceId, { recoveredAtMs: nowMs, escalated: false });
        report.recovered.push(label);
        recordActed(report, label, `${verdict.shape}: ${verdict.recovery}`);
      }
    } catch (err) {
      // Neither acted nor skipped: surfaces as "unaccounted" in the pass summary.
      log(`${label} recovery ${verdict.recovery} failed: ${errorMessage(err)}`);
    }
  }
  return report;
}

export interface ProgressInvariantSweepDeps {
  database: Database;
  recovery: ProgressRecoveryPort;
}

const DEFAULT_INTERVAL_MS = 2 * 60_000;
let activeSweep: PeriodicSweepHandle | null = null;

export function stopProgressInvariantSweep(): void {
  activeSweep?.stop();
  activeSweep = null;
}

/** Runs shortly after boot and then every monitor-cycle-ish interval. */
export function startProgressInvariantSweep(deps: ProgressInvariantSweepDeps, intervalMs = DEFAULT_INTERVAL_MS): PeriodicSweepHandle {
  stopProgressInvariantSweep();
  activeSweep = startPeriodicSweep({
    name: "progress-invariant",
    intervalMs,
    bootDelayMs: 60_000,
    tick: async () => {
      const report = await runProgressInvariantPass({ database: deps.database, recovery: deps.recovery });
      if (report.violations.length > 0) console.log(`[progress-invariant] ${formatPassReportBody(report)}`);
      return report;
    },
  });
  return activeSweep;
}

/** Production recovery port. `escalate` marks the workspace blocked and writes the ATTENTION event. */
export function createProgressRecoveryPort(deps: {
  database: Database;
  runWorkflowOnExit: (workspaceId: string, sessionId: string, exitCode: number | null, wasPlanMode?: boolean) => Promise<unknown>;
  relaunchReview: (workspaceId: string) => Promise<void>;
  sendBuilderTurn?: (workspaceId: string, content: string) => Promise<unknown>;
  lastSessionId: (workspaceId: string) => Promise<string | null>;
}): ProgressRecoveryPort {
  const { database } = deps;
  const port: ProgressRecoveryPort = {
    cancelGateJob(workspaceId, reason) {
      cancelMergeJob(workspaceId, reason);
    },
    clearBackoff: (workspaceId) => clearMergeBackoffState(workspaceId, database),
    async redriveExitCheck(workspaceId) {
      const sessionId = await deps.lastSessionId(workspaceId);
      if (!sessionId) throw new Error("no ended session to replay");
      await deps.runWorkflowOnExit(workspaceId, sessionId, 0, false);
    },
    relaunchReview: (workspaceId) => deps.relaunchReview(workspaceId),
    async followUpBuilder(workspaceId, content) {
      if (!deps.sendBuilderTurn) throw new Error("no builder-turn channel is wired");
      await deps.sendBuilderTurn(workspaceId, content);
    },
    async escalate(s, why) {
      await setWorkspaceStatus(database, s.workspaceId, "blocked", { caller: "progress-invariant" });
      await logBoardHealthEvent({
        projectId: s.projectId,
        cycleId: `progress-invariant-${s.workspaceId}`,
        eventType: "observation",
        category: "merge",
        issueNumber: s.issueNumber ?? undefined,
        summary: `needs_attention: #${s.issueNumber ?? "?"} has no driver — ${why}`,
        details: { workspaceId: s.workspaceId, why },
      }, database).catch(() => {});
    },
  };
  return port;
}

/** Test seam. */
export function resetProgressInvariantStateForTests(): void {
  recoveryState.clear();
}
