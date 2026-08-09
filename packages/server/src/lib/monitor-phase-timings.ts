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
// #368 added an environmental CONTROL spawn per cycle, because on this machine the SPREAD of the
// spawn-duration distribution exceeds the differences these timings were being used to compare.
// See `monitor-spawn-control.ts` for the 25-sample measurement and the design.
import { monitorEventLoopDelay } from "node:perf_hooks";
import { GIT_CONTROL_OPERATION_LABEL } from "@agentic-kanban/shared/lib/git-exec";
import type { ControlSpawnReport } from "./monitor-spawn-control.js";
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
   * Summed duration of the INSTRUMENTED SYNCHRONOUS calls inside this phase (`gitExecSync`, a
   * synchronous file read) — i.e. loop-blocking time this codebase can account for BY NAME.
   *
   * ── #368: this field, not `eventLoopDelay`, was the broken half of a reported contradiction ──
   *
   * Every phase reported `blockingMs: 0` while the same cycle's `eventLoopDelay` reported maxMs of
   * 11241 / 21274 / 12910, and that was read as "one of these two instruments is wrong". Neither
   * measurement was wrong; the NAME and the documented claim were. `blockingMs` never measured how
   * long the loop was blocked — it summed only the calls we happen to record with `blocking: true`,
   * so anything that stalls the process without going through `recordOperation` contributes zero:
   * the OS descheduling the whole process, a filter driver holding an IO, GC, native work inside a
   * dependency. On this machine that is exactly what happens (a `git --version` doing no repository
   * work MEASURED 68ms to 10203ms), and the old doc comment invited the reader to conclude from
   * `blockingMs: 0` that the loop was healthy while it was stalled for eleven seconds.
   *
   * Renamed to say what it actually counts. `eventLoopDelay` is the authority on loop health — it is
   * sampled by libuv and keeps measuring while JS is not running. A large `eventLoopDelay` beside a
   * zero `syncBlockingMs` is not a contradiction, it is a FINDING: the stall came from outside our
   * instrumented synchronous calls. Read the control spawn (`MonitorCycleTimings.controlSpawn`) to
   * see whether it came from outside this process altogether.
   */
  syncBlockingMs: number;
  /**
   * How congested the event loop was during this phase (#359) — the number that decides whether a
   * multi-second recorded git call means "the command was slow" or "the callback waited".
   *
   * The per-operation `totalMs` for an async spawn is call-to-CALLBACK, so it absorbs event-loop
   * delay. That is how `rev-parse` came to be reported at a 9.2s average with `blockingMs: 0`,
   * while a clean out-of-process harness measures `git --version` at 88-138ms on this machine. With
   * this beside it, an inflated operation figure is attributable instead of mysterious: high delay
   * plus a small `childMs` means the loop, not git.
   */
  eventLoopDelay: EventLoopDelayReport;
}

/** Event-loop delay over one window, in milliseconds. */
export interface EventLoopDelayReport {
  meanMs: number;
  maxMs: number;
  p99Ms: number;
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
  /** Summed INSTRUMENTED-SYNCHRONOUS time across the whole cycle — see the per-phase field (#368). */
  syncBlockingMs: number;
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
  /** Event-loop congestion across the whole cycle — see the per-phase field. */
  eventLoopDelay: EventLoopDelayReport;
  /**
   * The child-process time inside this cycle versus the call-to-callback time recorded against the
   * same calls (#359).
   *
   * `childMs` is what the spawned commands actually cost; `queueMs` is what their callbacks spent
   * waiting on the event loop and used to be reported as part of the command's duration. A large
   * `queueMs` share means every per-operation number gathered before this split is inflated, and
   * conclusions drawn from them — a per-spawn tax, a git-specific penalty, an antivirus story —
   * do not follow from the data.
   *
   * VERIFIED in #368: `queueMs` is now derived per-CALL (`childMeasuredTotalMs - childMs`) rather
   * than by pairing `childMs` with the whole label's `totalMs`, which let a call that never spawned
   * (ENOENT, no `exit` event, hence no `childMs`) donate its full duration to the wait side and
   * nothing to the child side. The control spawns are excluded, so the split describes the cycle's
   * real work only.
   *
   * The honest caveat stands: `exit` is still delivered through the event loop, so `childMs` is a
   * TIGHTER bound on the child's own cost, not a perfect one. Read it beside `eventLoopDelay` for
   * the same window, and beside `controlSpawn` to see whether the machine was stalled at all.
   */
  spawnTime: { childMs: number; queueMs: number; measuredCalls: number };
  /**
   * This cycle's own ENVIRONMENTAL BASELINE (#368) — control git spawns that do no repository work,
   * taken at cycle start, cycle end and throttled phase transitions, so a consumer can ask "was
   * this cycle measured during a stall?" instead of guessing. Null for a cycle that took none.
   *
   * Read this FIRST. On this machine the same zero-work command MEASURED 68ms to 10203ms in bursts,
   * which means the spread of the distribution exceeds the differences every other field here has
   * been used to compare. `controlSpawn.stalled === true` invalidates cross-cycle comparison of
   * everything else in this object.
   */
  controlSpawn: ControlSpawnReport | null;
}

export interface MonitorPhaseRecorder {
  /** Close the current phase (if any) and open `phase`. */
  enter(phase: string): void;
  /**
   * Close the final phase and return the completed cycle's timings.
   *
   * @param controlSpawn This cycle's environmental control report (#368), or null when none was
   *                     taken. Passed in rather than gathered here so the recorder stays pure and
   *                     synchronous — the probe is async and belongs to the cycle, not to the timer.
   */
  finish(controlSpawn?: ControlSpawnReport | null): MonitorCycleTimings;
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
  const cycleLoopDelay = openEventLoopDelayWindow();
  let phaseLoopDelay = openEventLoopDelayWindow();

  function close(atMs: number): void {
    const report = phaseWindow.close();
    phaseWindow = openOperationWindow();
    const delay = phaseLoopDelay.close();
    phaseLoopDelay = openEventLoopDelayWindow();
    phases.push({
      phase: currentPhase,
      startedAt: new Date(currentStartMs).toISOString(),
      durationMs: atMs - currentStartMs,
      operations: topWindowOperations(report),
      syncBlockingMs: sumOf(report, (stat) => stat.blockingMs),
      eventLoopDelay: delay,
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
    finish(controlSpawn: ControlSpawnReport | null = null): MonitorCycleTimings {
      const at = nowMs();
      close(at);
      const slowest = phases.reduce<MonitorPhaseTiming | null>(
        (worst, candidate) => (worst === null || candidate.durationMs > worst.durationMs ? candidate : worst),
        null,
      );
      // The phase window opened by the last `close` is never entered again — close it so an
      // abandoned window can never outlive the cycle that created it.
      phaseWindow.close();
      phaseLoopDelay.close();
      const cycleReport = cycleWindow.close();
      // The control probe's own spawns are excluded from every aggregate that describes the cycle's
      // REAL work — otherwise the instrument that exists to qualify these numbers would be inside
      // them, and its identical repeats would read as removable duplicate spawns (#368).
      const workReport = withoutControlSpawns(cycleReport);
      const childMs = sumOf(workReport, (stat) => stat.childMs);
      const measuredTotalMs = sumOf(workReport, (stat) => stat.childMeasuredTotalMs);
      return {
        startedAt: new Date(startMs).toISOString(),
        endedAt: new Date(at).toISOString(),
        totalMs: at - startMs,
        phases,
        slowestPhase: slowest,
        // The control label stays VISIBLE in the operation list — a reader should see it beside the
        // real subcommands — and is excluded only from the derived aggregates below.
        operations: topWindowOperations(cycleReport, 12),
        syncBlockingMs: sumOf(workReport, (stat) => stat.blockingMs),
        duplicateSpawns: {
          duplicateCalls: sumOf(workReport, (stat) => stat.duplicateCalls),
          totalCalls: sumOf(workReport, (stat) => stat.keyedCalls),
        },
        eventLoopDelay: cycleLoopDelay.close(),
        spawnTime: {
          childMs,
          // Never negative: a `childMs` recorded for a call whose `totalMs` landed in a different
          // window would otherwise read as a nonsense negative wait.
          queueMs: Math.max(0, measuredTotalMs - childMs),
          measuredCalls: sumOf(workReport, (stat) => stat.childMeasuredCalls),
        },
        controlSpawn,
      };
    },
  };
}

function sumOf(report: OperationWindowReport, pick: (stat: OperationWindowStat) => number): number {
  return Object.values(report).reduce((sum, stat) => sum + pick(stat), 0);
}

/** The window report minus the control probe's own spawns (#368). */
function withoutControlSpawns(report: OperationWindowReport): OperationWindowReport {
  if (!(GIT_CONTROL_OPERATION_LABEL in report)) return report;
  const out: OperationWindowReport = { ...report };
  delete out[GIT_CONTROL_OPERATION_LABEL];
  return out;
}

/**
 * Event-loop delay over one window, via `perf_hooks.monitorEventLoopDelay` (#359).
 *
 * Deliberately an INDEPENDENT instrument: it is sampled by libuv, not derived from any operation
 * we time, so it can adjudicate the operation numbers rather than share their bias. That is the
 * whole point — a recorded 9-second `git rev-parse` with a 90ms child and seconds of loop delay is
 * a queueing report, not a git report, and nothing in the previous instrumentation could tell those
 * apart.
 *
 * The histogram is `disable()`d on close so a cycle cannot leave a sampler running, and its values
 * are nanoseconds (hence the /1e6).
 */
interface EventLoopDelayWindow {
  close(): EventLoopDelayReport;
}

function openEventLoopDelayWindow(): EventLoopDelayWindow {
  let histogram: ReturnType<typeof monitorEventLoopDelay> | null = null;
  try {
    histogram = monitorEventLoopDelay({ resolution: 20 });
    histogram.enable();
  } catch {
    // A runtime without the sampler must not take the monitor down; the report degrades to zeros.
    histogram = null;
  }
  let closed: EventLoopDelayReport | null = null;
  return {
    close(): EventLoopDelayReport {
      if (closed) return closed;
      if (!histogram) {
        closed = { meanMs: 0, maxMs: 0, p99Ms: 0 };
        return closed;
      }
      histogram.disable();
      const ms = (ns: number) => (Number.isFinite(ns) ? Math.round(ns / 1e6) : 0);
      closed = {
        meanMs: ms(histogram.mean),
        maxMs: ms(histogram.max),
        p99Ms: ms(histogram.percentile(99)),
      };
      return closed;
    },
  };
}
