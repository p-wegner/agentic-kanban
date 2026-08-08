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

export interface MonitorPhaseTiming {
  phase: string;
  startedAt: string;
  durationMs: number;
}

export interface MonitorCycleTimings {
  startedAt: string;
  endedAt: string;
  totalMs: number;
  /** In transition order. The slowest phase is the one to look at. */
  phases: MonitorPhaseTiming[];
  /** Convenience for the UI/CLI: the single longest phase, or null for an empty cycle. */
  slowestPhase: MonitorPhaseTiming | null;
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

  function close(atMs: number): void {
    phases.push({
      phase: currentPhase,
      startedAt: new Date(currentStartMs).toISOString(),
      durationMs: atMs - currentStartMs,
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
      return {
        startedAt: new Date(startMs).toISOString(),
        endedAt: new Date(at).toISOString(),
        totalMs: at - startMs,
        phases,
        slowestPhase: slowest,
      };
    },
  };
}
