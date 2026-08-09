// Per-phase durations for a monitor cycle (#347).
//
// Stall windows correlated with monitor cycle starts (the first observed burst began 3s
// after `currentCycle.startedAt`), but from outside the process the culprit PHASE could
// not be pinned. `setPhase` already knows every transition — it just threw the timing
// away, keeping only the current phase name. This records the durations so the last
// completed cycle can be read back from monitor-status and lined up against the
// slow-request ring buffer and the `[loop-lag]` warnings.
//
// Pure and clock-injected: no state outside the instance, so it is directly testable.
//
// #359 added per-OPERATION attribution on top. Per-phase timing alone produced three different
// confident answers about "the" blocker across three windows on a quiet machine — 92%
// `processing-candidates` in one, 40% `compounding-setup` in the next, cycles growing 105s -> 180s
// -> 222s in a third — because a phase name says nothing about WHICH operation the seconds went
// into. Each phase now also carries the git spawns, process spawns and libsql round trips that
// happened inside it, taken as a diff of the process-wide `operation-metrics` counters, so the
// question "is this the same synchronous-round-trip pattern #349 found?" is answerable from the
// monitor-status payload instead of by guessing.

// #359 (second round) replaced the snapshot-diff reading of those counters with explicit
// measurement WINDOWS. Two numbers a cumulative diff cannot produce, and both were needed:
// `maxMs` (a max is not differenceable, so every window after the first slow one reported 0 —
// disclosed on the ticket, and it is the number that would confirm or kill a tail-latency story
// for a 9-second average `git rev-parse`), and `duplicateCalls` (how many spawns in the window
// repeated one the window had already seen — the ceiling on what any per-cycle memo could remove,
// which is what refuted this ticket's recommended fix).
import {
  openOperationWindow,
  topWindowOperations,
  type OperationWindow,
  type OperationWindowReport,
  type OperationWindowStat,
} from "@agentic-kanban/shared/lib/operation-windows";

export interface MonitorPhaseTiming {
  phase: string;
  startedAt: string;
  durationMs: number;
  /**
   * The costliest operations inside this phase, worst first (#359). Truncated — this rides in the
   * `/api/internal/monitor-status` payload, which a human reads.
   */
  operations: Array<OperationWindowStat & { label: string }>;
  /**
   * Summed duration of the calls inside this phase that BLOCKED the event loop (synchronous
   * spawns, synchronous file reads). This is the number that explains a bimodal `/api/health`:
   * pure-JS with no DB access, it can only be slow while the loop is blocked, and the measured
   * distribution was 9 of 24 samples under 15ms with 8 over 3s — the signature of long
   * synchronous blocks, not of general load.
   */
  blockingMs: number;
}

export interface MonitorCycleTimings {
  startedAt: string;
  endedAt: string;
  totalMs: number;
  /** In transition order. The slowest phase is the one to look at. */
  phases: MonitorPhaseTiming[];
  /** Convenience for the UI/CLI: the single longest phase, or null for an empty cycle. */
  slowestPhase: MonitorPhaseTiming | null;
  /**
   * Operation totals for the WHOLE cycle. Deliberately reported beside the per-phase breakdown:
   * the dominant phase moved between measurement windows while the cycle total barely did, so a
   * cost that recurs across phases is only visible when the cycle is summed as well as split.
   */
  operations: Array<OperationWindowStat & { label: string }>;
  /** Summed event-loop-blocking time across the whole cycle. */
  blockingMs: number;
  /**
   * Git spawns in this cycle whose `(cwd, argv)` had already been spawned earlier in the SAME
   * cycle — the exact number a perfect per-cycle memo could have removed, beside the total so the
   * share is readable without arithmetic.
   *
   * This is the number that settles #359's recommended fix instead of arguing about it: measured
   * over five consecutive live cycles at 57 active workspaces it was 5-19 of 65-120 spawns (7-25%,
   * median 12%), of which `rev-parse` contributed 5-9 of 33-58 (12-16%) — far short of the "most
   * of them" the fix assumed, and well inside the 46-85s cycle-to-cycle spread of the totals.
   */
  duplicateSpawns: { duplicateCalls: number; totalCalls: number };
}

export interface MonitorPhaseRecorder {
  /** Close the current phase (if any) and open `phase`. */
  enter(phase: string): void;
  /** Close the final phase and return the completed cycle's timings. */
  finish(): MonitorCycleTimings;
}

/**
 * @param nowMs  Injected clock (`() => Date.now()` in production) so tests are deterministic.
 */
export function createMonitorPhaseRecorder(
  initialPhase: string,
  nowMs: () => number = () => Date.now(),
): MonitorPhaseRecorder {
  const startMs = nowMs();
  const phases: MonitorPhaseTiming[] = [];
  let currentPhase = initialPhase;
  let currentStartMs = startMs;
  // One window for the whole cycle plus one per phase, nested: both see every operation, each with
  // its own duplicate set, so "repeated within this phase" and "repeated anywhere in this cycle"
  // are different — and correct — numbers. Both are always closed (`finish` runs in the cycle's
  // `finally`), which is what keeps their key sets short-lived.
  const cycleWindow: OperationWindow = openOperationWindow();
  let phaseWindow: OperationWindow = openOperationWindow();

  function close(atMs: number): void {
    const report = phaseWindow.close();
    phaseWindow = openOperationWindow();
    phases.push({
      phase: currentPhase,
      startedAt: new Date(currentStartMs).toISOString(),
      durationMs: atMs - currentStartMs,
      operations: topWindowOperations(report),
      blockingMs: sumOf(report, (stat) => stat.blockingMs),
    });
  }

  return {
    enter(phase: string): void {
      // A repeated setPhase for the phase already running is a no-op rather than a
      // zero-length duplicate row — several call sites re-assert their phase.
      if (phase === currentPhase) return;
      const at = nowMs();
      close(at);
      currentPhase = phase;
      currentStartMs = at;
    },
    finish(): MonitorCycleTimings {
      const at = nowMs();
      close(at);
      const slowest = phases.reduce<MonitorPhaseTiming | null>(
        (worst, candidate) => (worst === null || candidate.durationMs > worst.durationMs ? candidate : worst),
        null,
      );
      // The phase window opened by the last `close` is never entered again — close it so an
      // abandoned window can never outlive the cycle that created it.
      phaseWindow.close();
      const cycleReport = cycleWindow.close();
      return {
        startedAt: new Date(startMs).toISOString(),
        endedAt: new Date(at).toISOString(),
        totalMs: at - startMs,
        phases,
        slowestPhase: slowest,
        operations: topWindowOperations(cycleReport, 12),
        blockingMs: sumOf(cycleReport, (stat) => stat.blockingMs),
        duplicateSpawns: {
          duplicateCalls: sumOf(cycleReport, (stat) => stat.duplicateCalls),
          totalCalls: sumOf(cycleReport, (stat) => stat.keyedCalls),
        },
      };
    },
  };
}

function sumOf(report: OperationWindowReport, pick: (stat: OperationWindowStat) => number): number {
  return Object.values(report).reduce((sum, stat) => sum + pick(stat), 0);
}
