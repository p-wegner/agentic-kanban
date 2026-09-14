/**
 * Repair-then-retry for the NON-blocking setup path (#1125 ask 3).
 *
 * `born-blocked-reconciler.ts` only ever sees a BLOCKING setup failure — that is the only
 * path that parks a workspace `blocked`. A project with `setup_blocking = false` fires its
 * setup script without awaiting it (`workspace-provision.service.ts`), so the workspace goes
 * `active` regardless of the outcome and a failure only ever surfaces as a butler system
 * event (`reportFailedParallelSetup`) — nothing ever retries it. When that failure is the
 * pnpm-store I/O fault this ticket classifies (`services/setup-io-fault.ts`), the repair
 * (delete the one corrupt, content-addressed store entry) is exactly as safe here as it is
 * for a blocking project, so this sweep gives the non-blocking path its OWN retry rather than
 * widening the born-blocked query with a second, incompatible shape — that one requires zero
 * sessions and a `blocked` status; this one is the opposite on both.
 *
 * Deliberately narrow: only a failure CLASSIFIED as the I/O fault is retried here. Any other
 * non-blocking setup failure is unchanged — it is not this reconciler's job to second-guess an
 * arbitrary failed install underneath a running agent, only to repair the one fault that is
 * known to be transient with an identifiable cause.
 *
 * The workspace's STATUS is never touched: unlike the born-blocked case there is no known-
 * broken worktree to protect an agent from — the agent is already running in it. This only
 * repairs the store and re-runs the script so the environment is fixed for whatever the agent
 * (or a later merge-gate run) does next.
 */
import { and, eq, notInArray } from "drizzle-orm";
import { issues, projects, workspaceSetupRun, workspaces } from "@agentic-kanban/shared/schema";
import { runSetupScript } from "@agentic-kanban/shared/lib/setup-script";
import type { Database } from "../db/index.js";
import { db } from "../db/index.js";
import { restampWorkspaceSetupRun } from "../repositories/workspace-setup-run.repository.js";
import { emptyPassReport, formatPassReportBody, recordActed, recordSkipped, type PassReport } from "../lib/pass-report.js";
import { errorMessage } from "@agentic-kanban/shared/lib/error-message";
import { startPeriodicSweep, type PeriodicSweepHandle } from "../lib/periodic-sweep.js";
import { classifySetupFailure, describeSetupFailure, repairIoFault } from "../services/setup-io-fault.js";

/** Same interval as the born-blocked reconciler — no reason for these to diverge. */
export const NON_BLOCKING_SETUP_RETRY_INTERVAL_MS = 30 * 60 * 1000;
const SWEEP_INTERVAL_MS = 10 * 60 * 1000;
/** A closed workspace has no environment left worth repairing. */
const TERMINAL_WORKSPACE_STATUSES = ["closed"];

export type NonBlockingSetupRetryAction = "retry-setup" | "hold" | "skip";

export interface NonBlockingSetupRow {
  workspaceId: string;
  workingDir: string | null;
  setupScript: string | null;
  setupState: string | null;
  setupEndedAt: string | null;
  setupStdoutTail: string | null;
  setupStderrTail: string | null;
}

/** Pure, so the policy is testable without a database, a setup script or a clock. */
export function decideNonBlockingSetupRetryAction(
  row: NonBlockingSetupRow,
  nowMs: number,
  retryIntervalMs = NON_BLOCKING_SETUP_RETRY_INTERVAL_MS,
): { action: NonBlockingSetupRetryAction; reason: string } {
  if (row.setupState !== "failed") {
    return { action: "skip", reason: "no recorded setup failure" };
  }
  if (!row.setupScript || !row.workingDir) {
    return { action: "skip", reason: "setup failed but there is no script or worktree left to retry" };
  }
  const classification = classifySetupFailure({ stdout: row.setupStdoutTail, stderr: row.setupStderrTail });
  if (classification.kind !== "io-fault") {
    // Only the classified, known-transient fault gets a background retry here — an ordinary
    // failed install underneath an already-running agent is left exactly as before (the
    // butler system event remains the only signal for it).
    return { action: "skip", reason: "not classified as the known I/O fault — left to the butler event" };
  }
  const lastAttemptMs = row.setupEndedAt ? Date.parse(row.setupEndedAt) : Number.NaN;
  if (Number.isFinite(lastAttemptMs) && nowMs - lastAttemptMs < retryIntervalMs) {
    return { action: "hold", reason: `setup failed ${Math.round((nowMs - lastAttemptMs) / 60000)}m ago — inside the retry interval` };
  }
  return { action: "retry-setup", reason: "non-blocking setup failed with the classified I/O fault and has not been retried since" };
}

/** Every non-blocking-project workspace whose latest recorded setup run failed. */
export async function listFailedNonBlockingSetups(database: Database = db): Promise<NonBlockingSetupRow[]> {
  return database
    .select({
      workspaceId: workspaces.id,
      workingDir: workspaces.workingDir,
      setupScript: projects.setupScript,
      setupState: workspaceSetupRun.state,
      setupEndedAt: workspaceSetupRun.endedAt,
      setupStdoutTail: workspaceSetupRun.stdoutTail,
      setupStderrTail: workspaceSetupRun.stderrTail,
    })
    .from(workspaces)
    .innerJoin(workspaceSetupRun, eq(workspaceSetupRun.workspaceId, workspaces.id))
    .innerJoin(issues, eq(workspaces.issueId, issues.id))
    .innerJoin(projects, eq(issues.projectId, projects.id))
    .where(and(
      eq(workspaceSetupRun.state, "failed"),
      eq(projects.setupBlocking, false),
      notInArray(workspaces.status, TERMINAL_WORKSPACE_STATUSES),
    ));
}

export interface NonBlockingSetupRetrySweepResult extends PassReport {
  retried: string[];
  held: string[];
}

export async function reconcileNonBlockingSetupRetries(
  opts: {
    database?: Database;
    nowMs?: number;
    retryIntervalMs?: number;
    /** Injected for tests — defaults to actually running the project's setup script. */
    runSetup?: (worktreePath: string, script: string) => Promise<{ exitCode: number; stderr: string; stdout?: string }>;
    log?: (message: string) => void;
  } = {},
): Promise<NonBlockingSetupRetrySweepResult> {
  const database = opts.database ?? db;
  const nowMs = opts.nowMs ?? Date.now();
  const log = opts.log ?? ((message: string) => console.log(`[non-blocking-setup-retry] ${message}`));
  const runSetup = opts.runSetup
    ?? (async (worktreePath: string, script: string) => {
      const result = await runSetupScript(worktreePath, script);
      return { exitCode: result.exitCode, stderr: result.stderr, stdout: result.stdout };
    });

  const rows = await listFailedNonBlockingSetups(database).catch(() => [] as NonBlockingSetupRow[]);
  const result: NonBlockingSetupRetrySweepResult = { ...emptyPassReport(rows.length), retried: [], held: [] };
  const now = new Date(nowMs).toISOString();

  for (const row of rows) {
    const { action, reason } = decideNonBlockingSetupRetryAction(row, nowMs, opts.retryIntervalMs);
    const ref = `workspace ${row.workspaceId}`;
    if (action === "hold") {
      result.held.push(row.workspaceId);
      recordSkipped(result, row.workspaceId, reason);
      continue;
    }
    if (action === "skip") {
      recordSkipped(result, row.workspaceId, reason);
      continue;
    }
    // retry-setup: repair the classified I/O fault BEFORE retrying — the only retry with a
    // reason to succeed against a corrupted, content-addressed store entry.
    const classification = classifySetupFailure({ stdout: row.setupStdoutTail, stderr: row.setupStderrTail });
    const repairResult = await repairIoFault(classification);
    log(
      `${ref}: repairing a non-blocking setup I/O fault — `
      + `${repairResult.repaired ? "repaired" : "could NOT repair"} (${repairResult.reason})`,
    );
    let exitCode = 1;
    let stderr = "";
    let stdout = "";
    try {
      const run = await runSetup(row.workingDir!, row.setupScript!);
      exitCode = run.exitCode;
      stderr = run.stderr;
      stdout = run.stdout ?? "";
    } catch (err) {
      stderr = errorMessage(err);
    }
    const classificationLine = describeSetupFailure(classification, repairResult);
    const stderrTail = [classificationLine, stderr.slice(-2000)].filter(Boolean).join("\n");
    // Status is deliberately untouched (see file header) — only the run record is restamped.
    // `stdoutTail` is restamped with THIS run's own output (not left stale) — otherwise a
    // repeat failure against a DIFFERENT corrupt store entry would keep being classified off
    // the original, already-repaired path forever.
    await restampWorkspaceSetupRun(row.workspaceId, {
      state: exitCode === 0 ? "succeeded" : "failed",
      endedAt: now,
      exitCode,
      stderrTail,
      stdoutTail: stdout.slice(-2000),
    }, database);
    result.retried.push(row.workspaceId);
    recordActed(result, row.workspaceId, exitCode === 0 ? "retry-setup-succeeded" : "retry-setup-failed");
    log(`${ref}: setup retry ${exitCode === 0 ? "succeeded" : `failed again (exit ${exitCode})`} — verdict restamped`);
  }
  log(formatPassReportBody(result));
  return result;
}

let sweep: PeriodicSweepHandle | null = null;

export function startNonBlockingSetupRetryReconciler(opts: { intervalMs?: number } = {}): void {
  stopNonBlockingSetupRetryReconciler();
  sweep = startPeriodicSweep({
    name: "non-blocking-setup-retry",
    intervalMs: opts.intervalMs ?? SWEEP_INTERVAL_MS,
    tick: () => reconcileNonBlockingSetupRetries(),
  });
}

export function stopNonBlockingSetupRetryReconciler(): void {
  sweep?.stop();
  sweep = null;
}
