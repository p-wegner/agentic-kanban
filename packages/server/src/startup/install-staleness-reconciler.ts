/**
 * #685 — a deferred (`install mode: background`) dependency install has no timeout, no
 * reconciler and no re-run path, so a `pending`/`running` `repos.install_state` row is
 * unreclaimable the moment the runner that would advance it never gets to, or never finishes:
 *
 *  1. the blocking leading setup script fails, which skips `scheduleDeferredProvisionAndLaunch`
 *     entirely (`workspace-create.service.ts`) — `born-blocked-reconciler.ts` then releases the
 *     WORKSPACE to `idle`, but never touches the sibling repo rows it left behind;
 *  2. the server restarts or crashes mid-install;
 *  3. the deferred step returns early for any other reason (workspace deleted/closed, a throw
 *     in stack provisioning) before the runner starts.
 *
 * In every case the row is written `pending` at create time (`workspace-repos.service.ts`,
 * long before the runner would ever flip it to `running`/`done`/`failed`) and then nothing ever
 * advances it again. The merge gate (`pre-merge-gate-installs.ts`) refuses the branch forever,
 * tagged `pre_merge_gate_failed` — which by design stays out of every agent retry path — so the
 * operator's only signal is a refusal message that repeats every cycle.
 *
 * `installUpdatedAt` is stamped by every writer (`repo.repository.ts`) but was never READ
 * anywhere — the exact column a staleness check needs. This sweep is that check: a row stuck
 * `pending`/`running` past `STALE_TIMEOUT_MS` since its own last stamp is deemed abandoned and
 * flipped to `failed` with a detail explaining why, which does two things a silent-forever
 * `pending` cannot — it makes `blocksMerge` say something ACCURATE (a merge that will never be
 * unblocked reads as blocked-by-a-known-failure, not blocked-by-an-invisible-hang), and it gives
 * the operator a re-run path: relaunching/recreating the workspace re-provisions the repo, which
 * inserts a fresh row and starts the state machine over.
 *
 * #714 — two things had to be true for that to be safe, and neither was:
 *
 *  1. **The reclaim must be a compare-and-swap.** The rows are read by one `SELECT` and written
 *     by a later `UPDATE`, and the background runner writes the same rows — so a row that
 *     reached `done` in between was clobbered to `failed`. The write now carries the state this
 *     pass observed (`failRepoInstallIfStillIn`) and reports whether the swap landed.
 *  2. **"Stale" must mean NOT PROGRESSING, not STARTED A WHILE AGO.** `installUpdatedAt` only
 *     ever moved on a state transition, and the runner installs at concurrency 1 — so a single
 *     install longer than the window (allowed: `sibling_install_timeout_ms_<projectId>` goes up
 *     to three hours) and the tail of a multi-repo `pending` queue were both reclaimed while
 *     the runner was alive and healthy. The runner now HEARTBEATS its outstanding rows
 *     (`touchOutstandingRepoInstalls`, driven from `runBackgroundSiblingInstalls`), so an
 *     un-advanced stamp is evidence of abandonment rather than of a long job.
 *
 * A reconciler that exists to stop false merge blocks must not manufacture them.
 */
import type { RepoInstallState } from "@agentic-kanban/shared/lib/repo-install-state";
import { isRepoInstallState } from "@agentic-kanban/shared/lib/repo-install-state";
import type { Database } from "../db/index.js";
import { db } from "../db/index.js";
import { failRepoInstallIfStillIn, listOutstandingRepoInstallRows } from "../repositories/repo.repository.js";
import { emptyPassReport, recordActed, recordSkipped, type PassReport } from "../lib/pass-report.js";
import { startPeriodicSweep, type PeriodicSweepHandle } from "../lib/periodic-sweep.js";

/**
 * How long a `pending`/`running` install may sit with no update before it is deemed abandoned.
 * Since #714 a live runner heartbeats its outstanding rows, so this is a no-progress budget and
 * not a cap on how long an install may legitimately take.
 */
export const INSTALL_STALE_TIMEOUT_MS = 30 * 60 * 1000;
/** How often the reconciler sweeps. */
const SWEEP_INTERVAL_MS = 10 * 60 * 1000;

export interface OutstandingRepoInstallRow {
  workspaceId: string | null;
  path: string;
  name: string | null;
  installState: string | null;
  installUpdatedAt: string | null;
}

export type InstallStalenessAction = "fail" | "hold";

/**
 * Decide what to do with one outstanding install row. Pure, so the timeout policy is testable
 * without a database or a clock.
 *
 * The clock it reads is a HEARTBEAT since #714, not a start time: a runner that is making
 * progress re-stamps `installUpdatedAt` on its outstanding rows, so `ageMs` measures lack of
 * progress. A long-but-live install is held; a silent one is failed.
 *
 * A row with no readable `installUpdatedAt` is treated as stale rather than held forever — an
 * unparseable/missing timestamp must not become a permanent excuse not to act, the same lesson
 * `decideBornBlockedAction` already encodes for `setupEndedAt`.
 */
export function decideInstallStalenessAction(
  row: OutstandingRepoInstallRow,
  nowMs: number,
  timeoutMs = INSTALL_STALE_TIMEOUT_MS,
): { action: InstallStalenessAction; reason: string } {
  const updatedMs = row.installUpdatedAt ? Date.parse(row.installUpdatedAt) : Number.NaN;
  if (!Number.isFinite(updatedMs)) {
    return { action: "fail", reason: "installUpdatedAt is missing or unparseable — cannot prove the install is still in progress" };
  }
  const ageMs = nowMs - updatedMs;
  if (ageMs < timeoutMs) {
    return { action: "hold", reason: `updated ${Math.round(ageMs / 60000)}m ago — inside the timeout` };
  }
  return { action: "fail", reason: `state '${row.installState}' has not advanced in ${Math.round(ageMs / 60000)}m — treating as abandoned` };
}

/** #592 — the shared pass core, plus the outcome list only this pass has. */
export interface InstallStalenessSweepResult extends PassReport {
  failed: Array<{ workspaceId: string; path: string }>;
}

export async function reconcileStaleInstalls(
  opts: {
    database?: Database;
    nowMs?: number;
    timeoutMs?: number;
    log?: (message: string) => void;
  } = {},
): Promise<InstallStalenessSweepResult> {
  const database = opts.database ?? db;
  const nowMs = opts.nowMs ?? Date.now();
  const log = opts.log ?? ((message: string) => console.log(`[install-staleness] ${message}`));

  const rows = await listOutstandingRepoInstallRows(database).catch(() => [] as OutstandingRepoInstallRow[]);
  const result: InstallStalenessSweepResult = { ...emptyPassReport(rows.length), failed: [] };

  for (const row of rows) {
    if (!row.workspaceId) {
      recordSkipped(result, row.path, "no workspaceId — not a workspace-scoped row");
      continue;
    }
    const { action, reason } = decideInstallStalenessAction(row, nowMs, opts.timeoutMs);
    const ref = `workspace ${row.workspaceId} repo ${row.name ?? row.path}`;
    if (action === "hold") {
      recordSkipped(result, row.workspaceId, "hold");
      continue;
    }
    // #714 — the write is conditional on the state this pass READ. The rows come from a
    // `SELECT` taken before the decision, and the background runner writes the same rows, so
    // an unconditional `WHERE workspaceId AND path` clobbers a row that reached `done` in the
    // meantime. Naming the observed state in the `WHERE` turns the write into a
    // compare-and-swap: a row that moved on is simply not matched.
    const observed: RepoInstallState | null = isRepoInstallState(row.installState) ? row.installState : null;
    if (!observed) {
      recordSkipped(result, row.workspaceId, "unrecognised installState — nothing safe to swap from");
      continue;
    }
    const swapped = await failRepoInstallIfStillIn(
      {
        workspaceId: row.workspaceId,
        path: row.path,
        fromStates: [observed],
        detail: `install timed out — ${reason}`,
        now: new Date(nowMs).toISOString(),
      },
      database,
    );
    if (!swapped) {
      // It advanced under us — which is the good outcome, not a failure to act.
      recordSkipped(result, row.workspaceId, `advanced past '${observed}' since the scan — left alone`);
      log(`skipped ${ref} — install advanced past '${observed}' since this pass read it`);
      continue;
    }
    result.failed.push({ workspaceId: row.workspaceId, path: row.path });
    recordActed(result, row.workspaceId, "install-timed-out");
    log(`marked ${ref} install as failed — ${reason}`);
  }
  return result;
}

let sweep: PeriodicSweepHandle | null = null;

export function startInstallStalenessReconciler(opts: { intervalMs?: number } = {}): void {
  stopInstallStalenessReconciler();
  sweep = startPeriodicSweep({
    name: "install-staleness",
    intervalMs: opts.intervalMs ?? SWEEP_INTERVAL_MS,
    tick: () => reconcileStaleInstalls(),
  });
}

export function stopInstallStalenessReconciler(): void {
  sweep?.stop();
  sweep = null;
}
