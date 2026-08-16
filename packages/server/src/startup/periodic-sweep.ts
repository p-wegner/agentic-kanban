// One scheduler for the background reconcilers/reapers/scanners (#529).
//
// Twelve of them carried the same ~25-line block: two module-level timer handles, a
// `stopX()` clearing both, a `startX()` calling `stopX()` first as a hot-reload guard,
// `setTimeout(tick, <boot delay>)` + `setInterval(tick, intervalMs)`, and a
// `.catch(console.warn(...))` so one bad tick cannot kill the process.
//
// They drifted on the detail that is easiest to omit and hardest to notice: only the two
// most recently written (`service-stack-reaper`, `terminal-workspace-reaper`) called
// `.unref()`. A non-unref'd interval keeps the Node process ALIVE — which is invisible in
// the server (its listening socket holds the loop open anyway) and shows up somewhere
// else entirely, as a test run or CLI invocation that imports one of these modules and
// then hangs until the harness kills it.
//
// So `unref` defaults to TRUE here: a background sweep should never be the reason a
// process cannot exit. A caller that genuinely needs to hold the loop open must say so.

export interface PeriodicSweepHandle {
  /** Clears the boot timer and the interval. Idempotent. */
  stop(): void;
}

export interface PeriodicSweepOptions {
  /** Log tag, e.g. "reconcile" — used only for the per-tick error warning. */
  tag: string;
  /**
   * One sweep. May be async; a rejection is logged, never thrown. Returns `unknown`
   * because several sweeps return a count they use only in their own logging — the
   * scheduler must not force them to discard it.
   */
  tick: () => unknown;
  /**
   * Delay before the FIRST run. These are staggered per sweep (25s–45s today) so a boot
   * does not fire every reconciler at once, which is why it has no default.
   */
  bootDelayMs: number;
  intervalMs: number;
  /** Let the timers hold the process open. Default false (timers are unref'd). */
  keepProcessAlive?: boolean;
}

export function startPeriodicSweep(options: PeriodicSweepOptions): PeriodicSweepHandle {
  const { tag, tick, bootDelayMs, intervalMs, keepProcessAlive = false } = options;

  let bootTimer: ReturnType<typeof setTimeout> | null = null;
  let interval: ReturnType<typeof setInterval> | null = null;

  const runTick = () => {
    try {
      const result = tick();
      // A sync throw and a rejected promise both have to be swallowed: this runs from a
      // timer, so an escape is an unhandled rejection / uncaught exception, and these
      // sweeps are all best-effort by design.
      void Promise.resolve(result).catch((err: unknown) => {
        console.warn(`[${tag}] cycle error:`, err instanceof Error ? err.message : err);
      });
    } catch (err) {
      console.warn(`[${tag}] cycle error:`, err instanceof Error ? err.message : err);
    }
  };

  bootTimer = setTimeout(runTick, bootDelayMs);
  interval = setInterval(runTick, intervalMs);
  if (!keepProcessAlive) {
    bootTimer.unref?.();
    interval.unref?.();
  }

  return {
    stop() {
      if (bootTimer !== null) {
        clearTimeout(bootTimer);
        bootTimer = null;
      }
      if (interval !== null) {
        clearInterval(interval);
        interval = null;
      }
    },
  };
}
