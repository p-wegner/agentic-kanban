// #416 (extends #349): idle-window gating for the diagnostic health-warning refresh.
//
// #349 took the scan (historically 203-265s) off the cycle's critical path and throttled it
// to one run per 10 minutes — but it still STARTED whenever the throttle elapsed, i.e. often
// squarely inside a busy window: mid-cycle, or while the event loop was already lagging from
// other work. Since nothing in the cycle reads its output, the scan has no deadline at all;
// it should wait for a genuinely idle moment. This pure decision function says whether to
// start it NOW, given the loop-lag histogram and whether a cycle is in flight.
//
// It must still EVENTUALLY run — a permanently-busy board would otherwise never refresh its
// dirty-checkout / stall warnings — so deferral is capped: past `deferCapMs` since the last
// start, the scan runs regardless of business.

/** Deferral cap: past this since the last start, run even under a busy loop / in-flight cycle. */
export const HEALTH_WARNING_DEFER_CAP_MS = 30 * 60_000;
/** A loop whose current-window p90 lag exceeds this is "busy" — defer the scan. */
export const CALM_LOOP_MAX_P90_MS = 200;

export interface HealthRefreshGateInput {
  nowMs: number;
  /** When the last scan STARTED (0 = never — always runs, matching #349's boot behavior). */
  lastStartedAtMs: number;
  /** Single-flight: a scan already running always blocks another. */
  refreshRunning: boolean;
  /** The #349 rate limit (normally HEALTH_WARNING_REFRESH_INTERVAL_MS). */
  intervalMs: number;
  /** Is a monitor cycle executing right now? Busy — defer. */
  cycleInFlight: boolean;
  /** Current loop-lag window p90 in ms; null when no lag monitor is running (treated as calm). */
  loopLagP90Ms: number | null;
  force?: boolean;
  deferCapMs?: number;
  calmMaxP90Ms?: number;
}

export function shouldStartHealthRefresh(input: HealthRefreshGateInput): boolean {
  if (input.refreshRunning) return false; // single-flight beats everything, including force
  if (input.force) return true;
  const sinceLastStart = input.nowMs - input.lastStartedAtMs;
  if (sinceLastStart < input.intervalMs) return false; // #349 rate limit
  if (sinceLastStart >= (input.deferCapMs ?? HEALTH_WARNING_DEFER_CAP_MS)) return true; // must eventually run
  if (input.cycleInFlight) return false;
  const p90 = input.loopLagP90Ms;
  if (p90 !== null && p90 > (input.calmMaxP90Ms ?? CALM_LOOP_MAX_P90_MS)) return false;
  return true;
}
