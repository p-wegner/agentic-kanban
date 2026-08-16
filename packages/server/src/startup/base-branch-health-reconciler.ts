/**
 * Periodic base-branch health check (#491). Runs `verify_script` against every registered
 * project's CURRENT base-branch tip and persists the result, so "is the base green right now"
 * has an answer independent of any branch's own pre-merge gate.
 *
 * Deliberately best-effort and slow-paced: this is a background signal, not a gate, and each
 * project's verify run can itself take many minutes. Projects with no `verify_script`
 * configured are skipped cheaply (checked inside `verifyBaseBranchHealth`, itself a no-op).
 */

import { projects as projectsTable } from "@agentic-kanban/shared/schema";
import { db } from "../db/index.js";
import type { Database } from "../db/index.js";
import { verifyBaseBranchHealth } from "../services/base-branch-health.service.js";
import { startPeriodicSweep, type PeriodicSweepHandle } from "../lib/periodic-sweep.js";

const DEFAULT_INTERVAL_MS = 30 * 60 * 1000;
const INITIAL_DELAY_MS = 2 * 60 * 1000;

let activeSweep: PeriodicSweepHandle | null = null;
let tickInFlight = false;

export function stopBaseBranchHealthReconciler(): void {
  activeSweep?.stop();
  activeSweep = null;
}

/** Run one pass: verify every registered project's base branch, sequentially (never overlapping the build gate). */
export async function runBaseBranchHealthCheckOnce(database: Database = db): Promise<void> {
  if (tickInFlight) return; // a prior pass is still running (verify can take many minutes)
  tickInFlight = true;
  try {
    const rows = await database
      .select({ id: projectsTable.id })
      .from(projectsTable);
    for (const { id } of rows) {
      try {
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
    tick: () => runBaseBranchHealthCheckOnce(database),
  });
}
