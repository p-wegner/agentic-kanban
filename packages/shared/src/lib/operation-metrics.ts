/**
 * Process-wide per-OPERATION counters (#359).
 *
 * ── Why per-operation, and why per-phase timing was not enough ──
 *
 * `lastCyclePhaseTimings` (#347) answered "which phase was slow" and, asked three times on a quiet
 * machine, gave three different confident answers about "the" blocker:
 *
 * | phase | window A | window B | round 5 (3 consecutive cycles) |
 * |---|---|---|---|
 * | `processing-candidates` | 126.3s (92%) | 69.5s (51%) | 89s / 157s / 194s (85-88%) |
 * | `compounding-setup` | **1 ms** | **54.7s (40%)** | — |
 * | `resource-sweep` | 9.0s | 4.3s | 3.1s / 19.2s / 26.5s |
 * | total | 137.6s | 136.5s | 105s / 180s / 222s |
 *
 * Optimising whichever phase happened to look worst is how a round gets spent moving cost around.
 * What no phase timer can say is WHICH OPERATION the seconds went into — a git spawn, a libsql
 * round trip, a synchronous multi-MB file read — and that is the thing that actually recurs across
 * phases. #349's fix came from exactly this kind of attribution (82 synchronous libsql round trips
 * in one scan), and the same class of defect is the prior here.
 *
 * ── What it deliberately is not ──
 *
 * Not a histogram, not a tracing library, not sampled. A `Map` lookup plus four number adds per
 * operation, so it can sit on the git adapter and the preference read without becoming the thing it
 * measures. There is no timer, no async context and no per-call allocation beyond the label string
 * the caller already has.
 *
 * Counters are cumulative for the process lifetime; callers take a `snapshot()` before and after a
 * window and `diffOperations` them. That makes the same registry usable by the monitor (per phase),
 * a route (per request) and a test, without any of them owning reset semantics — a shared reset
 * would let two readers silently zero each other's baseline.
 */

export interface OperationStat {
  /** How many times the operation ran in this window. */
  calls: number;
  /** Summed wall-clock duration in ms. For SYNC operations this is also event-loop block time. */
  totalMs: number;
  /** Worst single call in ms — a p50 hides the multi-second block that makes /api/health bimodal. */
  maxMs: number;
  /**
   * Calls that blocked the event loop (a synchronous spawn or a synchronous file read). Split out
   * because 60s of awaited git and 60s of `execFileSync` cost the same wall clock and have
   * completely different consequences for every other request on the server.
   */
  blockingCalls: number;
  /** Summed duration of the blocking calls only. */
  blockingMs: number;
}

export type OperationSnapshot = Record<string, OperationStat>;

const counters = new Map<string, OperationStat>();

function statFor(label: string): OperationStat {
  let stat = counters.get(label);
  if (!stat) {
    stat = { calls: 0, totalMs: 0, maxMs: 0, blockingCalls: 0, blockingMs: 0 };
    counters.set(label, stat);
  }
  return stat;
}

/**
 * Record one operation.
 *
 * @param label      Stable, LOW-CARDINALITY identifier — `"git:rev-list"`, `"db:getPreference"`.
 *                   Never interpolate an id, a path or a project into it: the registry is a live
 *                   map with no eviction, so unbounded labels would be a slow leak.
 * @param durationMs Wall clock for the call.
 * @param blocking   True when the call ran synchronously on the event loop.
 */
export function recordOperation(label: string, durationMs: number, blocking = false): void {
  const stat = statFor(label);
  stat.calls += 1;
  stat.totalMs += durationMs;
  if (durationMs > stat.maxMs) stat.maxMs = durationMs;
  if (blocking) {
    stat.blockingCalls += 1;
    stat.blockingMs += durationMs;
  }
}

/** A copy of the current cumulative counters. Safe to hold — never mutated afterwards. */
export function snapshotOperations(): OperationSnapshot {
  const out: OperationSnapshot = {};
  for (const [label, stat] of counters) out[label] = { ...stat };
  return out;
}

/**
 * What happened between two snapshots. Labels with no calls in the window are omitted, so a phase
 * that did nothing reports `{}` rather than a wall of zeros.
 *
 * `maxMs` is the LATER snapshot's high-water mark when it grew in this window, and 0 otherwise —
 * a cumulative max cannot be differenced, and reporting the all-time max against a quiet window
 * would attribute an earlier phase's worst call to this one.
 */
export function diffOperations(before: OperationSnapshot, after: OperationSnapshot): OperationSnapshot {
  const out: OperationSnapshot = {};
  for (const [label, now] of Object.entries(after)) {
    const then = before[label] ?? { calls: 0, totalMs: 0, maxMs: 0, blockingCalls: 0, blockingMs: 0 };
    const calls = now.calls - then.calls;
    if (calls <= 0) continue;
    out[label] = {
      calls,
      totalMs: now.totalMs - then.totalMs,
      maxMs: now.maxMs > then.maxMs ? now.maxMs : 0,
      blockingCalls: now.blockingCalls - then.blockingCalls,
      blockingMs: now.blockingMs - then.blockingMs,
    };
  }
  return out;
}

/**
 * The operations that cost the most time in a window, worst first — what a reader actually wants
 * out of a diff. `limit` keeps a phase's report to a readable size in the monitor-status payload.
 */
export function topOperations(diff: OperationSnapshot, limit = 8): Array<OperationStat & { label: string }> {
  return Object.entries(diff)
    .map(([label, stat]) => ({ label, ...stat }))
    .sort((a, b) => b.totalMs - a.totalMs)
    .slice(0, limit);
}

/** Test seam only. Production never resets — see the module header on why callers diff instead. */
export function resetOperationsForTest(): void {
  counters.clear();
}
