/**
 * Periodic code-health report scan (#1619). Each tick looks at every project's base branch tip and
 * hands it to `scanCodeHealthOnce`, which scans a sha once and falls back to a daily scan for a
 * project with no landings. Cheap when nothing moved (two `git rev-parse` and one preference read).
 */
import { getAllProjects } from "../repositories/project.repository.js";
import type { Database } from "../db/index.js";
import { scanCodeHealthOnce } from "../services/code-health-scan.service.js";
import { startPeriodicSweep, type PeriodicSweepHandle } from "../lib/periodic-sweep.js";

const INTERVAL_MS = 5 * 60 * 1000;
const INITIAL_DELAY_MS = 4 * 60 * 1000;

let activeSweep: PeriodicSweepHandle | null = null;
let tickInFlight = false;

export function stopCodeHealthScanReconciler(): void {
  activeSweep?.stop();
  activeSweep = null;
}

/** One pass over every project. Never throws. */
export async function runCodeHealthScanOnce(database: Database): Promise<void> {
  if (tickInFlight) return;
  tickInFlight = true;
  try {
    for (const p of await getAllProjects(database)) {
      if (!p.repoPath || !p.defaultBranch) continue;
      await scanCodeHealthOnce({ projectId: p.id, repoPath: p.repoPath, defaultBranch: p.defaultBranch }, { database });
    }
  } catch (err) {
    console.warn("[code-health-scan] periodic tick error:", err instanceof Error ? err.message : String(err));
  } finally {
    tickInFlight = false;
  }
}

export function startCodeHealthScanReconciler(database: Database, intervalMs = INTERVAL_MS): void {
  stopCodeHealthScanReconciler();
  activeSweep = startPeriodicSweep({
    name: "code-health-scan",
    intervalMs,
    bootDelayMs: INITIAL_DELAY_MS,
    tick: () => runCodeHealthScanOnce(database),
  });
}
