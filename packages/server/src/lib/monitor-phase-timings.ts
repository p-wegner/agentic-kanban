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

import {
  diffOperations,
  snapshotOperations,
  topOperations,
  type OperationSnapshot,
  type OperationStat,
} from "@agentic-kanban/shared/lib/operation-metrics";

export interface MonitorPhaseTiming {
  phase: string;
  startedAt: string;
  durationMs: number;
  /**
   * The costliest operations inside this phase, worst first (#359). Truncated — this rides in the
   * `/api/internal/monitor-status` payload, which a human reads.
   */
  operations: Array<OperationStat & { label: string }>;
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
  operations: Array<OperationStat & { label: string }>;
  /** Summed event-loop-blocking time across the whole cycle. */
  blockingMs: number;
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
  const cycleOpsBefore: OperationSnapshot = snapshotOperations();
  let phaseOpsBefore: OperationSnapshot = cycleOpsBefore;

  function close(atMs: number): void {
    const after = snapshotOperations();
    const diff = diffOperations(phaseOpsBefore, after);
    phaseOpsBefore = after;
    phases.push({
      phase: currentPhase,
      startedAt: new Date(currentStartMs).toISOString(),
      durationMs: atMs - currentStartMs,
      operations: topOperations(diff),
      blockingMs: Object.values(diff).reduce((sum, stat) => sum + stat.blockingMs, 0),
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
      const cycleDiff = diffOperations(cycleOpsBefore, snapshotOperations());
      return {
        startedAt: new Date(startMs).toISOString(),
        endedAt: new Date(at).toISOString(),
        totalMs: at - startMs,
        phases,
        slowestPhase: slowest,
        operations: topOperations(cycleDiff, 12),
        blockingMs: Object.values(cycleDiff).reduce((sum, stat) => sum + stat.blockingMs, 0),
      };
    },
  };
}
