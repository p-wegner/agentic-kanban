// Event-loop lag instrumentation (#347).
//
// The board's dominant slowness is the single event loop being BLOCKED, not slow SQL:
// across an 8-rep benchmark of 20+ read endpoints, medians were ~0.21s but p90/max hit
// 6-18s on EVERY endpoint regardless of payload — including `GET /api/health`, which is
// pure JS with no I/O and measured 3.6-30s probed directly against the backend while
// system CPU sat at 25%. That is the signature of loop blocking, and it means one
// blocking code path degrades every request, WebSocket broadcast and SSE stream at once.
//
// The slow-request middleware measures wall time per request, which CONFLATES "this
// handler was slow" with "this handler sat behind someone else's block". A lag histogram
// separates the two: high lag with a fast handler means the blocker is elsewhere.
//
// perf_hooks.monitorEventLoopDelay is a libuv-level timer sampled off-thread, so it keeps
// measuring while JS is blocked — a setInterval-based probe cannot, because the block
// delays the probe itself.

import { monitorEventLoopDelay, type IntervalHistogram } from "node:perf_hooks";

/** Resolution of the underlying libuv timer. Lag below this is not observable. */
export const LOOP_LAG_RESOLUTION_MS = 10;
/** A window whose max lag exceeds this logs a `[loop-lag]` warning. */
export const LOOP_LAG_WARN_MS = 500;
/** How often the window is evaluated for the warning. */
export const LOOP_LAG_WARN_INTERVAL_MS = 10_000;

export interface LoopLagStats {
  /** Milliseconds of lag at each percentile over the current window. */
  p50: number;
  p90: number;
  p99: number;
  max: number;
  mean: number;
  /** Samples in the window. */
  count: number;
  /** When the current window opened. */
  windowStartedAt: string;
  /** When these numbers were read. */
  sampledAt: string;
  /**
   * Worst lag seen since the process started, and when. NEVER reset.
   *
   * Without this the gauge is actively misleading: the warning timer resets the shared
   * window every LOOP_LAG_WARN_INTERVAL_MS, so a scrape that lands just after a reset
   * reports `count: 0, max: 0` — observed for real while /api/health was taking 25-54s.
   * Someone investigating a stall would read zero lag and wrongly rule out blocking.
   * The high-water mark always carries evidence that a stall happened.
   */
  allTimeMax: number;
  allTimeMaxAt: string | null;
}

function toMs(nanoseconds: number): number {
  // The histogram reports nanoseconds; keep 0.1ms precision (below the 10ms resolution
  // the numbers are noise anyway, but rounding to whole ms would hide a clean zero).
  if (!Number.isFinite(nanoseconds)) return 0;
  return Math.round(nanoseconds / 1e5) / 10;
}

export interface LoopLagMonitor {
  /** Current window's stats. */
  stats(): LoopLagStats;
  /** Current window's stats, then open a fresh window (the scrape contract). */
  statsAndReset(): LoopLagStats;
  /** Stop sampling and the warning timer. */
  stop(): void;
}

/**
 * Start sampling event-loop delay.
 *
 * @param onWarn  Injected sink for the threshold warning (defaults to console.warn) —
 *                lets a test assert the warning without capturing console.
 * @param now     Injected clock, for deterministic tests.
 */
export function startLoopLagMonitor(options?: {
  warnThresholdMs?: number;
  warnIntervalMs?: number;
  onWarn?: (message: string, stats: LoopLagStats) => void;
  now?: () => Date;
}): LoopLagMonitor {
  const warnThresholdMs = options?.warnThresholdMs ?? LOOP_LAG_WARN_MS;
  const warnIntervalMs = options?.warnIntervalMs ?? LOOP_LAG_WARN_INTERVAL_MS;
  const onWarn = options?.onWarn ?? ((message) => { console.warn(message); });
  const now = options?.now ?? (() => new Date());

  const histogram: IntervalHistogram = monitorEventLoopDelay({ resolution: LOOP_LAG_RESOLUTION_MS });
  histogram.enable();
  let windowStartedAt = now().toISOString();
  let allTimeMax = 0;
  let allTimeMaxAt: string | null = null;

  /** Fold the current window's max into the never-reset high-water mark. */
  function captureHighWater(): void {
    const windowMax = toMs(histogram.max);
    if (windowMax > allTimeMax) {
      allTimeMax = windowMax;
      allTimeMaxAt = now().toISOString();
    }
  }

  function stats(): LoopLagStats {
    captureHighWater();
    return {
      p50: toMs(histogram.percentile(50)),
      p90: toMs(histogram.percentile(90)),
      p99: toMs(histogram.percentile(99)),
      max: toMs(histogram.max),
      mean: toMs(histogram.mean),
      count: histogram.count,
      windowStartedAt,
      sampledAt: now().toISOString(),
      allTimeMax,
      allTimeMaxAt,
    };
  }

  function statsAndReset(): LoopLagStats {
    const snapshot = stats(); // also folds this window into the high-water mark
    histogram.reset();
    windowStartedAt = now().toISOString();
    return snapshot;
  }

  // Warning timer. It reads AND resets, so each warning describes one window and a single
  // long stall is reported once instead of on every tick until the histogram rolls over.
  // The timestamp is what makes a stall correlatable with the slow-request ring buffer
  // and the monitor's phase log.
  const warnTimer = setInterval(() => {
    const snapshot = statsAndReset();
    if (snapshot.max >= warnThresholdMs) {
      onWarn(
        `[loop-lag] ${snapshot.windowStartedAt} window max=${snapshot.max}ms `
        + `p99=${snapshot.p99}ms p50=${snapshot.p50}ms over ${snapshot.count} samples `
        + `— the event loop was blocked; every request/WS/SSE was delayed by this`,
        snapshot,
      );
    }
  }, warnIntervalMs);
  warnTimer.unref?.();

  return {
    stats,
    statsAndReset,
    stop() {
      clearInterval(warnTimer);
      histogram.disable();
    },
  };
}
