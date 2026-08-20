// Process-wide handle for the event-loop lag monitor (#347).
//
// There is exactly one event loop, so there is exactly one histogram. The route needs to
// read it and server-start needs to own its lifecycle, and routes must not import from
// server-start (circular). This tiny registry is the seam — the same shape as the
// slow-request ring buffer's module-level state.

import { startLoopLagMonitor, type LoopLagMonitor } from "./loop-lag-monitor.js";

export { LOOP_LAG_WARN_MS } from "./loop-lag-monitor.js";

let monitor: LoopLagMonitor | null = null;

/** Start sampling if not already started. Idempotent — a hot-reload must not stack timers. */
export function ensureLoopLagMonitor(): LoopLagMonitor {
  monitor ??= startLoopLagMonitor();
  return monitor;
}

/** The running monitor, or null when sampling was never started (e.g. in unit tests). */
export function getLoopLagMonitor(): LoopLagMonitor | null {
  return monitor;
}

/** Stop sampling and clear the handle. */
export function stopLoopLagMonitor(): void {
  monitor?.stop();
  monitor = null;
}
