/**
 * Recovery for a workspace that was BORN `blocked` — inserted and blocked in the same
 * millisecond, with no session ever created (#394).
 *
 * ── The measured shape ──
 *
 * Found while verifying #387's quota-block release on `eventhub`. #387 released all 12
 * quota-blocked workspaces; six stayed blocked for an unrelated reason: zero rows in `sessions`
 * and `created_at == updated_at` to within 8ms.
 *
 * | issue | workspace | issue status | created_at | sessions |
 * |---|---|---|---|---|
 * | #84 | 5ce7bd0f | In Review | 2026-08-08T20:26:40.383Z | 0 |
 * | #85 | bb653012 | **Done**   | 2026-08-08T20:57:27.361Z | 0 |
 * | #92 | 203c9212 | In Review | 2026-08-09T04:34:18.799Z | 0 |
 * | #92 | 7bccdddb | In Review | 2026-08-09T04:35:05.389Z | 0 |
 * | #93 | 25dfeaea | In Progress | 2026-08-09T04:58:58.299Z | 0 |
 * | #93 | 0dc708fb | In Progress | 2026-08-09T05:00:48.353Z | 0 |
 *
 * The creation path is `workspace-create.service.ts`'s `setupFailedBlocking` (#169): a BLOCKING
 * setup script that failed must not launch an agent into a worktree missing its dependencies, so
 * the row is parked `blocked` and the deferred launch is skipped. That decision is right. What was
 * missing is any way out of it.
 *
 * ── Why it was permanent ──
 *
 * - `handleBlockedWorkspace` (monitor cycle) releases only a QUOTA block (#387), correctly — with
 *   no session there is no stats blob to classify and nothing to release.
 * - `reconcileCompletionStates` `innerJoin`s `sessions`, so a zero-session workspace is excluded
 *   under EVERY configuration. #387's analysis already noted this as the half it did not address.
 * - Nothing else transitions `blocked`.
 *
 * ── What this does, and what it deliberately does not ──
 *
 * It does NOT release a setup-failed workspace straight to `idle`. That would hand the normal
 * start path a worktree whose dependencies are known-missing and reintroduce exactly the opaque
 * merge-gate failure hours later that #169 exists to prevent. Instead it RE-RUNS the blocking
 * setup script — the thing that actually failed — and releases only on success. Setup scripts are
 * idempotent by convention (`pnpm install -r`, `cargo fetch`, `uv sync`), and a great many of
 * these failures are transient (a network blip mid-install). A repeat failure restamps
 * `latest_setup_*`, so the operator sees a fresh, dated verdict instead of one from five days ago.
 *
 * A workspace with NO recorded setup failure is a different animal: something parked it `blocked`
 * with no evidence attached, which is unrecoverable by construction. That one goes to `idle`,
 * where the ordinary rules can act — there is no known-broken worktree to protect against.
 *
 * And a workspace whose ISSUE is already terminal is closed outright (#394 ask 4). eventhub's #85
 * was Done with a still-`blocked` workspace, and because `ACTIVE_WORKSPACE_STATUSES` includes
 * `blocked`, it kept counting toward `activeIssueCount` and re-supplying a stall signal for work
 * that had finished.
 */
import { and, eq, inArray, notExists, sql } from "drizzle-orm";
import { issues, projectStatuses, projects, sessions, workspaceSetupRun, workspaces } from "@agentic-kanban/shared/schema";
import { runSetupScript } from "@agentic-kanban/shared/lib/setup-script";
import type { Database } from "../db/index.js";
import { db } from "../db/index.js";
import { setWorkspaceStatus } from "../repositories/workspace-status.repository.js";
import { restampWorkspaceSetupRun } from "../repositories/workspace-setup-run.repository.js";
import { emptyPassReport, formatPassReportBody, recordActed, recordSkipped, type PassReport } from "../lib/pass-report.js";
import { errorMessage } from "@agentic-kanban/shared/lib/error-message";
import { startPeriodicSweep, type PeriodicSweepHandle } from "../lib/periodic-sweep.js";
import { closeWorkspace } from "../services/workspace-lifecycle-reconcile.service.js";

/** How long since the last setup attempt before this reconciler will try again. */
export const SETUP_RETRY_INTERVAL_MS = 30 * 60 * 1000;
/** How often the reconciler sweeps. */
const SWEEP_INTERVAL_MS = 10 * 60 * 1000;
/** Statuses that make an issue's leftover workspace ordinary history rather than a wedge. */
const TERMINAL_ISSUE_STATUSES = ["Done", "Cancelled"];

export type BornBlockedAction = "close" | "retry-setup" | "release" | "hold";

export interface BornBlockedRow {
  workspaceId: string;
  issueId: string;
  issueNumber: number | null;
  issueStatusName: string;
  projectId: string;
  workingDir: string | null;
  setupScript: string | null;
  setupState: string | null;
  setupEndedAt: string | null;
}

/**
 * Decide what to do with one born-blocked workspace. Pure, so the whole policy above is testable
 * without a repo, a setup script or a clock.
 */
export function decideBornBlockedAction(
  row: BornBlockedRow,
  nowMs: number,
  retryIntervalMs = SETUP_RETRY_INTERVAL_MS,
): { action: BornBlockedAction; reason: string } {
  if (TERMINAL_ISSUE_STATUSES.includes(row.issueStatusName)) {
    return { action: "close", reason: `issue is ${row.issueStatusName} — a terminal issue's leftover workspace belongs closed, not blocked` };
  }
  if (row.setupState !== "failed") {
    // Blocked, no session, and no recorded reason: a status with no evidence attached. There is no
    // known-broken worktree to protect, so the ordinary rules get it back.
    return { action: "release", reason: "blocked with no session and no recorded setup failure — nothing to protect against" };
  }
  if (!row.setupScript || !row.workingDir) {
    return { action: "hold", reason: "setup failed but there is no script or worktree left to retry" };
  }
  const lastAttemptMs = row.setupEndedAt ? Date.parse(row.setupEndedAt) : Number.NaN;
  if (Number.isFinite(lastAttemptMs) && nowMs - lastAttemptMs < retryIntervalMs) {
    return { action: "hold", reason: `setup failed ${Math.round((nowMs - lastAttemptMs) / 60000)}m ago — inside the retry interval` };
  }
  return { action: "retry-setup", reason: "blocking setup script failed and has not been retried since" };
}

/** The `blocked` workspaces that have never had a session row. */
export async function listBornBlockedWorkspaces(database: Database = db): Promise<BornBlockedRow[]> {
  return database
    .select({
      workspaceId: workspaces.id,
      issueId: issues.id,
      issueNumber: issues.issueNumber,
      issueStatusName: projectStatuses.name,
      projectId: issues.projectId,
      workingDir: workspaces.workingDir,
      setupScript: projects.setupScript,
      // #815: the setup run moved to `workspace_setup_run`, aliased back to the same two
      // field names the sweep reads.
      setupState: workspaceSetupRun.state,
      setupEndedAt: workspaceSetupRun.endedAt,
    })
    .from(workspaces)
    // LEFT, not inner — a blocked workspace with no setup record must still be swept.
    .leftJoin(workspaceSetupRun, eq(workspaceSetupRun.workspaceId, workspaces.id))
    .innerJoin(issues, eq(workspaces.issueId, issues.id))
    .innerJoin(projectStatuses, eq(issues.statusId, projectStatuses.id))
    .innerJoin(projects, eq(issues.projectId, projects.id))
    .where(and(
      inArray(workspaces.status, ["blocked"]),
      notExists(
        database.select({ one: sql`1` }).from(sessions).where(eq(sessions.workspaceId, workspaces.id)),
      ),
    ));
}

/** #592 — the shared pass core, plus the outcome lists only this pass has. */
export interface BornBlockedSweepResult extends PassReport {
  closed: string[];
  released: string[];
  retriedAndReleased: string[];
  held: string[];
}

export async function reconcileBornBlockedWorkspaces(
  opts: {
    database?: Database;
    now?: number;
    retryIntervalMs?: number;
    /** Injected for tests — defaults to actually running the project's setup script. */
    runSetup?: (worktreePath: string, script: string) => Promise<{ exitCode: number; stderr: string }>;
    log?: (message: string) => void;
  } = {},
): Promise<BornBlockedSweepResult> {
  const database = opts.database ?? db;
  const nowMs = opts.now ?? Date.now();
  const log = opts.log ?? ((message: string) => console.log(`[born-blocked] ${message}`));
  const runSetup = opts.runSetup
    ?? (async (worktreePath: string, script: string) => {
      const result = await runSetupScript(worktreePath, script);
      return { exitCode: result.exitCode, stderr: result.stderr };
    });

  const rows = await listBornBlockedWorkspaces(database).catch(() => [] as BornBlockedRow[]);
  const result: BornBlockedSweepResult = { ...emptyPassReport(rows.length), closed: [], released: [], retriedAndReleased: [], held: [] };
  const now = new Date(nowMs).toISOString();

  for (const row of rows) {
    const { action, reason } = decideBornBlockedAction(row, nowMs, opts.retryIntervalMs);
    const ref = `workspace ${row.workspaceId} (issue #${row.issueNumber ?? "?"})`;
    if (action === "hold") {
      result.held.push(row.workspaceId);
      recordSkipped(result, row.workspaceId, "hold");
      continue;
    }
    if (action === "close") {
      // #547: the documented close transition, so a born-blocked closure stamps `closedAt`
      // and shows up in the activity/timeline/digest readers like every other close.
      // `markMerged: false` — this workspace never produced anything to merge.
      await closeWorkspace({ database, workspaceId: row.workspaceId, now, markMerged: false });
      result.closed.push(row.workspaceId);
      recordActed(result, row.workspaceId, "close");
      log(`closed ${ref} — ${reason}`);
      continue;
    }
    if (action === "release") {
      await setWorkspaceStatus(database, row.workspaceId, "idle", { now });
      result.released.push(row.workspaceId);
      recordActed(result, row.workspaceId, "release");
      log(`released ${ref} to idle — ${reason}`);
      continue;
    }
    // retry-setup
    log(`re-running the blocking setup script for ${ref} — ${reason}`);
    let exitCode = 1;
    let stderr = "";
    try {
      const run = await runSetup(row.workingDir!, row.setupScript!);
      exitCode = run.exitCode;
      stderr = run.stderr;
    } catch (err) {
      stderr = errorMessage(err);
    }
    // Restamp either way: a repeat failure dated today is a usable report, one dated five days ago
    // is what made this state look untouched.
    // #815: the verdict lives in `workspace_setup_run` now. Still a PARTIAL write — the four
    // fields that make the verdict dated and readable — and an upsert, because the old
    // four-column UPDATE could never miss a row and this must not start missing one.
    await restampWorkspaceSetupRun(row.workspaceId, {
      state: exitCode === 0 ? "succeeded" : "failed",
      endedAt: now,
      exitCode,
      stderrTail: stderr.slice(-2000),
    }, database);
    await database.update(workspaces).set({ updatedAt: now })
      .where(eq(workspaces.id, row.workspaceId));
    if (exitCode === 0) {
      await setWorkspaceStatus(database, row.workspaceId, "idle", { now });
      result.retriedAndReleased.push(row.workspaceId);
      recordActed(result, row.workspaceId, "retry-setup-succeeded");
      log(`setup succeeded on retry for ${ref} — released to idle`);
    } else {
      result.held.push(row.workspaceId);
      recordSkipped(result, row.workspaceId, "retry-setup-failed");
      log(`setup failed again for ${ref} (exit ${exitCode}) — still blocked, verdict restamped`);
    }
  }
  // #689: the summary line is the reason `PassReport` exists — without it, a row that threw
  // mid-loop and landed in neither `closed`/`released`/`retriedAndReleased`/`held` was
  // invisible; this is what actually names it "N unaccounted" instead of a silent swallow.
  // Through the injected `log`, not `console` — it already applies the `[born-blocked]`
  // tag (#616) and is what lets a test silence the pass.
  log(formatPassReportBody(result));
  return result;
}

let sweep: PeriodicSweepHandle | null = null;

export function startBornBlockedReconciler(opts: { intervalMs?: number } = {}): void {
  // #529: was `if (timer) return`, so a tsx-watch reload left the OLD interval live
  // and never armed the new code; and with no boot run, crash recovery waited a full
  // interval. startPeriodicSweep stops-then-restarts and runs once after a boot delay.
  stopBornBlockedReconciler();
  sweep = startPeriodicSweep({
    name: "born-blocked",
    intervalMs: opts.intervalMs ?? SWEEP_INTERVAL_MS,
    tick: () => reconcileBornBlockedWorkspaces(),
  });
}

export function stopBornBlockedReconciler(): void {
  sweep?.stop();
  sweep = null;
}
