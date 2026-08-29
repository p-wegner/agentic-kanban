/**
 * Periodic base-branch health check (#491). Runs `verify_script` against every registered
 * project's CURRENT base-branch tip and persists the result, so "is the base green right now"
 * has an answer independent of any branch's own pre-merge gate.
 *
 * Deliberately best-effort and slow-paced: this is a background signal, not a gate, and each
 * project's verify run can itself take many minutes. Projects with no `verify_script`
 * configured are skipped cheaply (checked inside `verifyBaseBranchHealth`, itself a no-op).
 *
 * This file is the SWEEP only. Whether a probe is due (`isBaseHealthProbeDue`,
 * `resolveBaseHealthProbeDue`) and the on-demand door that asks for one
 * (`requestBaseBranchReprobe`) moved to `services/base-branch-health-reprobe.service.ts` in
 * #947 — they are needed by a route and by the merge gate, neither of which may import
 * `startup/`. See that file's header for the layering argument.
 */

import { projects as projectsTable } from "@agentic-kanban/shared/schema";
import { db } from "../db/index.js";
import type { Database } from "../db/index.js";
import { verifyBaseBranchHealth } from "../services/base-branch-health.service.js";
import { startPeriodicSweep, type PeriodicSweepHandle } from "../lib/periodic-sweep.js";
import {
  resolveBaseHealthProbeDue,
  BASE_HEALTH_DEFAULT_INTERVAL_MS,
} from "../services/base-branch-health-reprobe.service.js";

const DEFAULT_INTERVAL_MS = BASE_HEALTH_DEFAULT_INTERVAL_MS;
const INITIAL_DELAY_MS = 2 * 60 * 1000;

let activeSweep: PeriodicSweepHandle | null = null;
let tickInFlight = false;

export function stopBaseBranchHealthReconciler(): void {
  activeSweep?.stop();
  activeSweep = null;
}

/**
 * Run one pass: verify every registered project's base branch, sequentially.
 *
 * A project whose last recorded result is NEWER than one interval is skipped (#699 follow-up).
 *
 * Without that, the "periodic" in this sweep's name was not true. `INITIAL_DELAY_MS` is two
 * minutes and `tsx watch` restarts the dev server on every merge, so a run of merges re-armed
 * the sweep from scratch each time and it started over — a full `verify_script` for EVERY
 * registered project, ~25 of them, serially. Measured today: it was running a second complete
 * copy of `pnpm check:arch && pnpm typecheck && pnpm test:mine` on the main checkout alongside
 * a developer's own suite, which is the most likely source of the `Worker exited unexpectedly`
 * crashes and 5s guard-suite timeouts that read as unrelated test failures.
 *
 * `tickInFlight` never covered this: it guards a pass against ITSELF within one process, and
 * every one of these passes was in a freshly restarted process. Persisted recency is the only
 * thing a restart cannot forget.
 *
 * #712 completed that argument. Recency was stamped only at the END of a probe, so throughout
 * the 45–60 minutes one ran, the persisted "last result" was still the OLD one and every
 * restart in that window started a rival verify anyway. The probe now also stamps its START
 * (a preference, see `baseHealthProbeStartPrefKey`), and `isBaseHealthProbeDue` reads both —
 * along with the two arithmetic defects at the same site: a `timeout` outcome being due again
 * before it could even have finished, and a future `createdAt` making the delta negative and
 * so silently permanently "recent".
 */
export async function runBaseBranchHealthCheckOnce(
  database: Database = db,
  intervalMs = DEFAULT_INTERVAL_MS,
  nowMs: number = Date.now(),
): Promise<void> {
  if (tickInFlight) return; // a prior pass is still running (verify can take many minutes)
  tickInFlight = true;
  try {
    const rows = await database
      .select({ id: projectsTable.id })
      .from(projectsTable);
    for (const { id } of rows) {
      try {
        const verdict = await resolveBaseHealthProbeDue(id, database, intervalMs, nowMs);
        if (!verdict.due) continue;
        await verifyBaseBranchHealth(id, database);
      } catch (err) {
        console.warn(`[base-branch-health] check failed for project ${id} (non-fatal):`, err instanceof Error ? err.message : String(err));
      }
    }
  } catch (err) {
    console.warn("[base-branch-health] periodic tick error:", err instanceof Error ? err.message : String(err));
  } finally {
    tickInFlight = false;
  }
}

/** Start the periodic base-branch health reconciler (background-services registry). */
export function startBaseBranchHealthReconciler(database: Database = db, intervalMs = DEFAULT_INTERVAL_MS): void {
  stopBaseBranchHealthReconciler();
  activeSweep = startPeriodicSweep({
    name: "base-branch-health",
    intervalMs,
    bootDelayMs: INITIAL_DELAY_MS,
    tick: () => runBaseBranchHealthCheckOnce(database, intervalMs),
  });
}
