/**
 * Periodic GitHub CI watch on each project's base branch (#1562). Same cadence gate as the
 * base-health sweep: a project whose risk posture was never explicitly chosen is not watched
 * (the opt-in rule, #983), and the tick is cheap (one `gh run list` per watched project), so it
 * runs far more often than the verify sweep.
 */
import { getAllProjects } from "../repositories/project.repository.js";
import { db } from "../db/index.js";
import type { Database } from "../db/index.js";
import { toPrefMap } from "@agentic-kanban/shared/lib/preference-map";
import { getAllPreferencesCached } from "../repositories/preferences.repository.js";
import { resolveRiskPosture, resolveBaseSweepIntervalMs } from "../services/risk-posture.service.js";
import { pollProjectCi } from "../services/ci-status.service.js";
import { startPeriodicSweep, type PeriodicSweepHandle } from "../lib/periodic-sweep.js";

const INTERVAL_MS = 30 * 60 * 1000;
const INITIAL_DELAY_MS = 3 * 60 * 1000;

let activeSweep: PeriodicSweepHandle | null = null;
let tickInFlight = false;

export function stopCiStatusReconciler(): void {
  activeSweep?.stop();
  activeSweep = null;
}

/** One pass over every watched project. Never throws. */
export async function runCiStatusCheckOnce(database: Database = db): Promise<void> {
  if (tickInFlight) return;
  tickInFlight = true;
  try {
    const rows = await getAllProjects(database);
    const prefMap = toPrefMap(await getAllPreferencesCached(database).catch(() => []));
    for (const { id } of rows) {
      if (resolveBaseSweepIntervalMs(resolveRiskPosture(prefMap, id)) === null) continue;
      await pollProjectCi(id, database);
    }
  } catch (err) {
    console.warn("[ci-status] periodic tick error:", err instanceof Error ? err.message : String(err));
  } finally {
    tickInFlight = false;
  }
}

export function startCiStatusReconciler(database: Database = db, intervalMs = INTERVAL_MS): void {
  stopCiStatusReconciler();
  activeSweep = startPeriodicSweep({
    name: "ci-status",
    intervalMs,
    bootDelayMs: INITIAL_DELAY_MS,
    tick: () => runCiStatusCheckOnce(database),
  });
}
