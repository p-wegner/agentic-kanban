// Retry a board call while the freshly restarted board answers `503 STARTUP_NOT_READY` (#1651).
// The board gates most endpoints for about a minute after a restart; promote's post-restart
// follow-ups (train hold release, master re-probe) must wait that out instead of giving up.
export const STARTUP_RETRY_TIMEOUT_MS = 3 * 60_000;
export const STARTUP_RETRY_INTERVAL_MS = 6_000;

/** True for the board's startup-readiness 503 (`readiness.ts`). */
export async function isStartupNotReady(res) {
  if (!res || res.status !== 503) return false;
  try {
    const body = await res.clone().json();
    return body?.code === "STARTUP_NOT_READY";
  } catch {
    return false;
  }
}

/**
 * Call `doFetch()` (returns a fetch Response) until it stops answering STARTUP_NOT_READY or the
 * bound passes; returns the last Response. Network errors propagate to the caller.
 */
export async function fetchWhileStarting(doFetch, opts = {}) {
  const sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const timeoutMs = opts.timeoutMs ?? STARTUP_RETRY_TIMEOUT_MS;
  const intervalMs = opts.intervalMs ?? STARTUP_RETRY_INTERVAL_MS;
  const now = opts.nowMs ?? (() => Date.now());
  const deadline = now() + timeoutMs;
  for (;;) {
    const res = await doFetch();
    if (!(await isStartupNotReady(res)) || now() + intervalMs > deadline) return res;
    await sleep(intervalMs);
  }
}
