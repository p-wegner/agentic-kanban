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
 */
import { and, eq } from "drizzle-orm";
import { repos } from "@agentic-kanban/shared/schema";
import type { Database } from "../db/index.js";
import { db } from "../db/index.js";
import { listOutstandingRepoInstallRows } from "../repositories/repo.repository.js";
import { emptyPassReport, recordActed, recordSkipped, type PassReport } from "../lib/pass-report.js";
import { startPeriodicSweep, type PeriodicSweepHandle } from "../lib/periodic-sweep.js";

/** How long a `pending`/`running` install may sit with no update before it is deemed abandoned. */
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
    await database
      .update(repos)
      .set({
        installState: "failed",
        installDetail: `install timed out — ${reason}`,
        installUpdatedAt: new Date(nowMs).toISOString(),
      })
      .where(and(eq(repos.workspaceId, row.workspaceId), eq(repos.path, row.path)));
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
