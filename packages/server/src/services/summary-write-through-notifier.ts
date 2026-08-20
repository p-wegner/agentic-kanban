/**
 * G13 (2026-08-11 read-path audit) — background write-throughs mutate
 * board-visible fields (diff stats, conflict cache, code metrics, the #399 git
 * projection) WITHOUT going through boardEvents.broadcast(), so the board ETag
 * memo's generation never moved and a conditional GET could keep 304-ing a body
 * that no longer matched the DB.
 *
 * This module is the seam: write sites call {@link notifySummaryWriteThrough}
 * AFTER a successful write that actually CHANGED a board-visible value (callers
 * gate on value change, so steady-state refreshes that rewrite identical facts
 * stay silent), and the batched listener — registered by the projects route,
 * which owns the workspace-summary cache whose generation backs the board ETag
 * fast path — invalidates the affected projects once per burst.
 *
 * Batching: write-throughs fire in bursts (a board rebuild schedules a sweep of
 * refresh tasks; the 5-min heal tick refreshes up to 8 rows). Invalidating per
 * row would thrash the memo, so notifications collect for DEBOUNCE_MS and flush
 * as one listener call carrying the distinct workspace ids.
 */

type SummaryWriteThroughListener = (workspaceIds: string[]) => void | Promise<void>;

const DEBOUNCE_MS = 500;

let listener: SummaryWriteThroughListener | null = null;
const pending = new Set<string>();
let timer: ReturnType<typeof setTimeout> | null = null;

/** Register the (single) batch listener. Pass null to detach (tests). */
export function setSummaryWriteThroughListener(l: SummaryWriteThroughListener | null): void {
  listener = l;
}

/** Record that a background write-through changed board-visible data for a workspace. */
export function notifySummaryWriteThrough(workspaceId: string): void {
  if (!listener) return;
  pending.add(workspaceId);
  if (timer) return;
  timer = setTimeout(() => {
    void flushSummaryWriteThroughs();
  }, DEBOUNCE_MS);
  timer.unref?.();
}

/** Flush the pending batch immediately (also the timer body). Awaitable for tests. */
export async function flushSummaryWriteThroughs(): Promise<void> {
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  if (pending.size === 0) return;
  const ids = [...pending];
  pending.clear();
  try {
    await listener?.(ids);
  } catch {
    // Invalidation is best-effort; the 15-min hard cap on the ETag memo bounds the damage.
  }
}
