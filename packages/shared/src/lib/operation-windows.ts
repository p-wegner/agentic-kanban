/**
 * Explicit MEASUREMENT WINDOWS over the per-operation counters (#359, second round).
 *
 * `operation-metrics` counts cumulatively for the process lifetime and lets a reader diff two
 * snapshots. That is enough for `calls` and `totalMs`, and it is provably NOT enough for two
 * questions the last round of #359 needed and could not answer:
 *
 * 1. **"What was the worst single call in this phase?"** A cumulative maximum cannot be
 *    differenced. `diffOperations` therefore reports `maxMs` only when the window happened to set
 *    a new process-wide high-water mark, so after the first slow cycle EVERY later window reports
 *    `maxMs: 0`. Measured consequence, disclosed on the ticket: all ~40 operation records in a
 *    reported cycle read `maxMs: 0`, which is exactly the number that would confirm or kill a
 *    tail-latency explanation for a 9-second average `git rev-parse`.
 * 2. **"How much of this cost is a REPEAT of a call already made in the same window?"** i.e. the
 *    ceiling on what any per-cycle memo could remove. #359's recommended fix was to memoize
 *    per-cycle `rev-parse` on the assumption that "most resolve a HEAD or a branch tip that cannot
 *    change within a cycle, so a per-cycle memo would remove most of them outright". That
 *    assumption is checkable only by counting exact `(cwd, argv)` repeats inside one cycle, which
 *    no cumulative counter can express — it had to be measured with a throwaway patch to the git
 *    spawn site, and the answer (12-16% of `rev-parse`, 7-25% of all git spawns) refuted the fix.
 *    Nobody should have to re-patch the spawn site to ask that again.
 *
 * A window is opened and closed EXPLICITLY by its owner (the monitor cycle and each of its
 * phases), so there is no shared reset for two readers to zero out from under each other, and no
 * state at all when nobody is measuring: with no window open, `feedOperationWindows` returns after
 * one `size` check. Windows nest freely — a cycle window and the phase window inside it both see
 * every call, each with its own dedupe set.
 *
 * Bounded by construction: the dedupe key set is capped per window (`MAX_WINDOW_KEYS`) and the
 * window is discarded on `close()`, so an unclosed window degrades to `keysTruncated: true`
 * instead of growing without limit. Keys are deliberately NOT stored in the cumulative registry —
 * that map has no eviction, and a key carries a path, a ref and sometimes a SHA.
 */

/** Ceiling on distinct dedupe keys tracked per window; past it, duplicate counting stops. */
export const MAX_WINDOW_KEYS = 4000;

export interface OperationWindowStat {
  /** How many times the operation ran inside this window. */
  calls: number;
  /** Summed wall-clock duration in ms. */
  totalMs: number;
  /** Worst single call in this window — a true per-window max, not a differenced global one. */
  maxMs: number;
  /** Calls that ran synchronously and held the event loop. */
  blockingCalls: number;
  /** Summed duration of the blocking calls only. */
  blockingMs: number;
  /**
   * Calls whose dedupe key (`cwd` + argv for a git spawn) had ALREADY been seen in this window.
   * The number of spawns a perfect window-scoped memo could have removed — no more, no less.
   * Calls made without a dedupe key never count as duplicates.
   */
  duplicateCalls: number;
  /**
   * Calls that carried a dedupe key at all — the denominator for `duplicateCalls`. Reported
   * separately from `calls` because an operation with no call identity (a preference read) can
   * never be a duplicate and must not dilute the share.
   */
  keyedCalls: number;
  /**
   * Summed lifetime of the CHILD PROCESS itself, for the calls that can measure it (#359).
   *
   * `totalMs` above is call-to-CALLBACK, and for an async spawn that includes however long Node
   * took to deliver the callback — so on a saturated event loop a 90ms git process is recorded as
   * a multi-second "git call". That is not a hypothesis: `rev-parse` was reported averaging
   * 9,231ms and 9,153ms across two independent cycles (1% apart, implausibly stable for disk
   * work) with `blockingMs: 0`, while a clean out-of-process harness measures `git --version` at
   * 88-138ms on the same machine. Every per-operation duration gathered before this field existed
   * therefore mixes "the call was slow" with "the call waited", under a name that implies the
   * first — and conclusions drawn from those numbers should be treated as suspect.
   *
   * Measured from the child's `exit` event rather than from the `execFile` callback, so it
   * excludes stdio drain and the callback's queue wait. It is still delivered through the event
   * loop, so it is a much tighter bound, not a perfect one — read it together with the event-loop
   * delay the caller reports for the same window.
   */
  childMs: number;
  /** Worst single measured child lifetime in this window. */
  maxChildMs: number;
  /** Calls that reported a child lifetime — the denominator for `childMs`. */
  childMeasuredCalls: number;
}

export type OperationWindowReport = Record<string, OperationWindowStat>;

export interface OperationWindow {
  /** Close the window and return what happened inside it. Idempotent; later calls report the same. */
  close(): OperationWindowReport;
}

interface WindowState {
  stats: Map<string, OperationWindowStat>;
  seen: Set<string>;
  keysTruncated: boolean;
  closed: boolean;
  report: OperationWindowReport | null;
}

const openWindows = new Set<WindowState>();

/** Open a measurement window. The caller MUST close it — see the module header on boundedness. */
export function openOperationWindow(): OperationWindow {
  const state: WindowState = { stats: new Map(), seen: new Set(), keysTruncated: false, closed: false, report: null };
  openWindows.add(state);
  return {
    close(): OperationWindowReport {
      if (!state.closed) {
        state.closed = true;
        openWindows.delete(state);
        const report: OperationWindowReport = {};
        for (const [label, stat] of state.stats) report[label] = { ...stat };
        state.report = report;
        state.stats.clear();
        state.seen.clear();
      }
      return state.report ?? {};
    },
  };
}

/**
 * Feed one operation to every open window. Called by `recordOperation` — never directly by a
 * measured call site, so the two registries can never disagree about what happened.
 *
 * @param dedupeKey Identity of this exact call (`cwd` + argv), for duplicate counting. Omit for
 *                  operations that have no meaningful identity (a preference read is not a repeat
 *                  of another preference read just because both were reads).
 */
export function feedOperationWindows(
  label: string,
  durationMs: number,
  blocking: boolean,
  dedupeKey?: string,
  childMs?: number,
): void {
  if (openWindows.size === 0) return;
  for (const state of openWindows) {
    let stat = state.stats.get(label);
    if (!stat) {
      stat = {
        calls: 0, totalMs: 0, maxMs: 0, blockingCalls: 0, blockingMs: 0,
        duplicateCalls: 0, keyedCalls: 0, childMs: 0, maxChildMs: 0, childMeasuredCalls: 0,
      };
      state.stats.set(label, stat);
    }
    stat.calls += 1;
    stat.totalMs += durationMs;
    if (durationMs > stat.maxMs) stat.maxMs = durationMs;
    if (blocking) {
      stat.blockingCalls += 1;
      stat.blockingMs += durationMs;
    }
    if (childMs !== undefined) {
      stat.childMeasuredCalls += 1;
      stat.childMs += childMs;
      if (childMs > stat.maxChildMs) stat.maxChildMs = childMs;
    }
    if (dedupeKey === undefined) continue;
    stat.keyedCalls += 1;
    const key = `${label} ${dedupeKey}`;
    if (state.seen.has(key)) {
      stat.duplicateCalls += 1;
    } else if (state.seen.size < MAX_WINDOW_KEYS) {
      state.seen.add(key);
    } else {
      state.keysTruncated = true;
    }
  }
}

/** The operations that cost the most in a window, worst first. */
export function topWindowOperations(
  report: OperationWindowReport,
  limit = 8,
): Array<OperationWindowStat & { label: string }> {
  return Object.entries(report)
    .map(([label, stat]) => ({ label, ...stat }))
    .sort((a, b) => b.totalMs - a.totalMs)
    .slice(0, limit);
}

/** Test seam: how many windows are currently open. Production code never needs this. */
export function openWindowCountForTest(): number {
  return openWindows.size;
}
