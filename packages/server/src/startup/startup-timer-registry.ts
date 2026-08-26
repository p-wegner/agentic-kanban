/**
 * Startup timer cleanup registry, extracted from `server-start.ts` (#873).
 *
 * A fresh `startServer()` call (tsx hot-reload, or a test harness restarting the
 * server) must tear down the PREVIOUS boot's timers before installing new ones,
 * or handles accumulate silently across restarts. `replaceStartupTimerCleanup`
 * is the seam every startup timer owner registers a cleanup into.
 */

let activeStartupTimerCleanup: (() => void) | null = null;

export function cleanupStartupTimers(): void {
  if (!activeStartupTimerCleanup) return;
  const cleanup = activeStartupTimerCleanup;
  activeStartupTimerCleanup = null;
  cleanup();
}

export function replaceStartupTimerCleanup(cleanupCallbacks: Array<() => void>): void {
  cleanupStartupTimers();
  activeStartupTimerCleanup = () => {
    for (const cleanup of cleanupCallbacks.splice(0).reverse()) {
      cleanup();
    }
  };
}
