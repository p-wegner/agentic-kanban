// One scheduler for the background reconcilers/reapers/scanners (#529).
//
// Twelve of these carried the same ~25-line block: two module-level handles, a
// `stopX()` clearing both, a `startX()` calling `stopX()` first as a hot-reload
// guard, `setTimeout(tick, <bootDelay>)` + `setInterval(tick, intervalMs)`, and a
// `.catch(console.warn(...))`. Copying it twelve times let three behaviours drift
// apart, and each divergence is a real defect rather than a style difference:
//
//  * `if (timer) return` instead of stop-then-restart (born-blocked,
//    workflow-node-divergence). Under `tsx watch` the module is re-evaluated but the
//    OLD interval is still live, so the guard sees a timer and returns — the sweep
//    keeps running against the PREVIOUS closure's dependencies, forever, and the new
//    code never arms. Silent and very hard to see.
//  * No boot-delay run (same two). These sweeps exist for crash recovery; without a
//    boot run the first pass is one full interval late, which for a 10-minute
//    interval means ten minutes of unreconciled state after every restart.
//  * `unref` present in 7, absent in 5. An un-unref'd interval keeps the event loop
//    alive, so the process will not exit cleanly on its own.
//
// Defaults here encode the majority-correct behaviour: always stop-then-restart,
// always run once after a boot delay, always unref.

export interface PeriodicSweepOptions {
  /** Log tag, e.g. "born-blocked" — used verbatim in the tick-error warning. */
  name: string;
  /** Steady-state period. */
  intervalMs: number;
  /**
   * Delay before the first (crash-recovery) run. Pass `null` to skip the boot run
   * entirely — only correct for a sweep that must never act on startup state.
   */
  bootDelayMs?: number | null;
  /** Keep the process alive for this timer? Default false (i.e. unref). */
  keepProcessAlive?: boolean;
  /**
   * The work. Rejections are caught and logged, never thrown into the timer.
   * Returns `unknown` on purpose: several sweeps return a result object they use in
   * tests, and forcing `Promise<void>` here would push a `void` cast onto every one
   * of them — which is exactly the kind of noise that made the copies diverge.
   */
  tick: () => unknown;
}

export interface PeriodicSweepHandle {
  /** Idempotent: safe to call when already stopped. */
  stop(): void;
  /** The steady-state interval, for callers that still return it. */
  interval: ReturnType<typeof setInterval>;
}

const DEFAULT_BOOT_DELAY_MS = 25_000;

export function startPeriodicSweep(options: PeriodicSweepOptions): PeriodicSweepHandle {
  const { name, intervalMs, bootDelayMs = DEFAULT_BOOT_DELAY_MS, keepProcessAlive = false, tick } = options;

  const run = () => {
    try {
      const result = tick() as { catch?: (fn: (err: unknown) => void) => unknown } | undefined;
      if (result && typeof result.catch === "function") {
        result.catch((err: unknown) => {
          console.warn(`[${name}] tick error:`, err instanceof Error ? err.message : err);
        });
      }
    } catch (err) {
      // A SYNCHRONOUS throw in the tick would otherwise escape into the timer and
      // become an unhandled exception, taking the process down.
      console.warn(`[${name}] tick error:`, err instanceof Error ? err.message : err);
    }
  };

  let bootTimeout: ReturnType<typeof setTimeout> | null = null;
  if (bootDelayMs !== null) {
    bootTimeout = setTimeout(run, bootDelayMs);
    if (!keepProcessAlive) bootTimeout.unref?.();
  }

  const interval = setInterval(run, intervalMs);
  if (!keepProcessAlive) interval.unref?.();

  return {
    interval,
    stop() {
      if (bootTimeout !== null) {
        clearTimeout(bootTimeout);
        bootTimeout = null;
      }
      clearInterval(interval);
    },
  };
}
