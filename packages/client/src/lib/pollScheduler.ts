/**
 * Shared polling scheduler for the board's background pollers.
 *
 * Two perf behaviors (measured: the four independent pollers phase-aligned at
 * mount and stormed the server in the same ~700ms window every interval,
 * producing 3.3-3.8s contention spikes):
 *
 * 1. Random initial phase offset — the first tick fires after `rand * interval`
 *    so independent pollers spread out instead of all firing together.
 * 2. Visibility gating — ticks are skipped while `document.hidden`; when the
 *    tab becomes visible again after a skipped tick, one immediate refresh
 *    runs so the UI catches up. (Headless Chromium reports visible, so E2E
 *    polling behavior is unchanged.)
 *
 * Callers keep doing their own immediate initial load at mount; this helper
 * only schedules the recurring ticks.
 */

export interface PollHandle {
  /** Clears all timers and listeners. Safe to call more than once. */
  stop(): void;
}

export function startStaggeredPoll(fn: () => void, intervalMs: number): PollHandle {
  let stopped = false;
  let intervalId: ReturnType<typeof setInterval> | null = null;
  let timeoutId: ReturnType<typeof setTimeout> | null = null;
  // Set when a tick was skipped because the tab was hidden — triggers one
  // immediate catch-up refresh on the next visibilitychange to visible.
  let missedWhileHidden = false;

  const tick = () => {
    if (stopped) return;
    if (typeof document !== "undefined" && document.hidden) {
      missedWhileHidden = true;
      return;
    }
    fn();
  };

  // Random phase offset before the first tick, then the steady interval.
  // Floor at 25% of the interval so the first tick never lands right on top
  // of the caller's own immediate initial load at mount.
  const initialDelayMs = (0.25 + 0.75 * Math.random()) * intervalMs;
  timeoutId = setTimeout(() => {
    timeoutId = null;
    if (stopped) return;
    tick();
    intervalId = setInterval(tick, intervalMs);
  }, initialDelayMs);

  const onVisibilityChange = () => {
    if (stopped) return;
    if (typeof document !== "undefined" && !document.hidden && missedWhileHidden) {
      missedWhileHidden = false;
      fn();
    }
  };
  if (typeof document !== "undefined") {
    document.addEventListener("visibilitychange", onVisibilityChange);
  }

  return {
    stop() {
      stopped = true;
      if (timeoutId !== null) {
        clearTimeout(timeoutId);
        timeoutId = null;
      }
      if (intervalId !== null) {
        clearInterval(intervalId);
        intervalId = null;
      }
      if (typeof document !== "undefined") {
        document.removeEventListener("visibilitychange", onVisibilityChange);
      }
    },
  };
}
