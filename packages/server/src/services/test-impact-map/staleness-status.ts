/**
 * One operator-facing status line for the test-impact map's staleness (#1519).
 *
 * Two producers used to speak independently: every gate warned "impact map is STALE" (250 lines in
 * one board.log) and the monitor said nothing when it skipped a rebuild. This keeps the monitor's
 * last decision per project, and gives both producers a way to log only on CHANGE / at a bounded
 * rate.
 */

const lastStatusByProject = new Map<string, string>();
const lastGateWarnMs = { value: 0 };

/** Minimum spacing between the per-gate STALE warnings. */
export const GATE_STALE_WARN_INTERVAL_MS = 10 * 60_000;

/** True (and records it) when `status` differs from the last one logged for the project. */
export function recordImpactMapStatus(projectId: string, status: string): boolean {
  if (lastStatusByProject.get(projectId) === status) return false;
  lastStatusByProject.set(projectId, status);
  return true;
}

/** Rate-limit gate STALE warnings: true when one may be logged now. */
export function shouldWarnGateStale(nowMs: number = Date.now()): boolean {
  if (nowMs - lastGateWarnMs.value < GATE_STALE_WARN_INTERVAL_MS) return false;
  lastGateWarnMs.value = nowMs;
  return true;
}

export function resetImpactMapStatusForTests(): void {
  lastStatusByProject.clear();
  lastGateWarnMs.value = 0;
}
