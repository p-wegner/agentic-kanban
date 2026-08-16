// One polling primitive for the client (#518).
//
// `lib/pollScheduler.ts` already solves the two things a background poller must get
// right — a random initial phase so independent pollers do not storm the server in the
// same window, and visibility gating so a hidden tab stops polling (both with a measured
// rationale in that file's header). Six network pollers bypassed it with a raw
// `setInterval` and got neither, which is the exact storm it was written to fix.
//
// Separately, eight components hand-rolled a "re-render every N seconds" ticker as
// `useState(Date.now())` + `setInterval`. Those are NOT network pollers, but they share
// the same defect: a hidden tab kept re-rendering them forever.
//
// Both shapes are one hook each here, over the same scheduler.

import { useEffect, useRef, useState } from "react";
import { startStaggeredPoll } from "../lib/pollScheduler.js";

/**
 * Run `fn` every `intervalMs` through the staggered, visibility-gated scheduler.
 *
 * `fn` is held in a ref, so a caller may pass an inline closure without restarting the
 * timer on every render — the interval restarts only when `intervalMs` or `enabled`
 * changes. Callers keep doing their own immediate initial load at mount; this schedules
 * the recurring ticks only, exactly like `startStaggeredPoll`.
 */
export function usePoll(fn: () => void, intervalMs: number, enabled = true): void {
  const fnRef = useRef(fn);
  fnRef.current = fn;

  useEffect(() => {
    if (!enabled) return;
    const handle = startStaggeredPoll(() => fnRef.current(), intervalMs);
    return () => handle.stop();
  }, [intervalMs, enabled]);
}

/**
 * A clock that re-renders the component every `intervalMs`, returning `Date.now()`.
 *
 * For elapsed-time and relative-time displays. Ticks are visibility-gated like any other
 * poll, so a backgrounded tab stops re-rendering; the catch-up tick on becoming visible
 * means the displayed time is never stale once the tab is looked at again.
 */
export function useNow(intervalMs = 1000, enabled = true): number {
  const [now, setNow] = useState(() => Date.now());
  usePoll(() => setNow(Date.now()), intervalMs, enabled);
  return now;
}
