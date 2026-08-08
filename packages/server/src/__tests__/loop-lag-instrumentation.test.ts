// #347: the board's dominant slowness is the single event loop being BLOCKED, not slow
// SQL — /api/health (pure JS, no I/O) measured 3.6-30s while system CPU sat at 25% — and
// it was unattributable at runtime, because the slow-request middleware measures wall
// time per request and so conflates "this handler was slow" with "this handler sat behind
// someone else's block". These tests cover the two pieces that make a stall name its
// blocker: the lag histogram (with its warning threshold) and per-phase cycle timings.
import { describe, it, expect, vi } from "vitest";
import { startLoopLagMonitor, LOOP_LAG_WARN_MS } from "../lib/loop-lag-monitor.js";
import { createMonitorPhaseRecorder } from "../lib/monitor-phase-timings.js";

/** Block the event loop synchronously for at least `ms`, the thing being measured. */
function blockEventLoop(ms: number): void {
  const until = Date.now() + ms;
  while (Date.now() < until) { /* deliberate spin */ }
}

describe("loop lag monitor (#347)", () => {
  it("measures a real synchronous block, which a setInterval probe could not", async () => {
    // perf_hooks samples at the libuv level, off-thread, so it keeps measuring WHILE JS is
    // blocked. A JS-timer probe is delayed by the very block it is trying to observe.
    const monitor = startLoopLagMonitor({ warnIntervalMs: 60_000 });
    try {
      // Let the histogram take some baseline samples, then stall the loop.
      await new Promise((resolve) => setTimeout(resolve, 30));
      blockEventLoop(250);
      await new Promise((resolve) => setTimeout(resolve, 30));

      const stats = monitor.stats();
      expect(stats.count).toBeGreaterThan(0);
      // Generous lower bound: the box is loaded and the histogram resolution is 10ms.
      expect(stats.max).toBeGreaterThan(100);
      expect(stats.p99).toBeGreaterThan(0);
      expect(stats.max).toBeGreaterThanOrEqual(stats.p99);
      expect(stats.p99).toBeGreaterThanOrEqual(stats.p50);
      expect(typeof stats.windowStartedAt).toBe("string");
      expect(typeof stats.sampledAt).toBe("string");
    } finally {
      monitor.stop();
    }
  });

  it("statsAndReset opens a fresh window so a scraper gets disjoint samples", async () => {
    const monitor = startLoopLagMonitor({ warnIntervalMs: 60_000 });
    try {
      await new Promise((resolve) => setTimeout(resolve, 20));
      blockEventLoop(200);
      await new Promise((resolve) => setTimeout(resolve, 20));

      const first = monitor.statsAndReset();
      expect(first.max).toBeGreaterThan(100);

      // The next window must NOT still be reporting the previous window's stall.
      await new Promise((resolve) => setTimeout(resolve, 30));
      const second = monitor.stats();
      expect(second.max).toBeLessThan(first.max);
      expect(second.windowStartedAt >= first.windowStartedAt).toBe(true);
    } finally {
      monitor.stop();
    }
  });

  it("keeps a never-reset high-water mark, so a scrape after a reset cannot report zero lag", async () => {
    // The gauge was actively misleading without this: the warning timer resets the shared
    // window every interval, so a read landing just after a reset returns
    // `count: 0, max: 0`. Observed for real while /api/health was taking 25-54s — someone
    // investigating a stall would read zero and wrongly rule out event-loop blocking.
    const monitor = startLoopLagMonitor({ warnIntervalMs: 60_000 });
    try {
      await new Promise((resolve) => setTimeout(resolve, 20));
      blockEventLoop(250);
      await new Promise((resolve) => setTimeout(resolve, 20));

      const stalled = monitor.statsAndReset();
      expect(stalled.max).toBeGreaterThan(100);
      expect(stalled.allTimeMax).toBeGreaterThanOrEqual(stalled.max);
      expect(stalled.allTimeMaxAt).not.toBeNull();

      // A fresh, quiet window: the WINDOW is clean but the evidence survives.
      const after = monitor.stats();
      expect(after.max).toBeLessThan(stalled.max);
      expect(after.allTimeMax).toBe(stalled.allTimeMax);
      expect(after.allTimeMaxAt).toBe(stalled.allTimeMaxAt);
    } finally {
      monitor.stop();
    }
  });

  it("reports a zeroed high-water mark on an idle loop rather than null noise", async () => {
    const monitor = startLoopLagMonitor({ warnIntervalMs: 60_000 });
    try {
      await new Promise((resolve) => setTimeout(resolve, 30));
      const stats = monitor.stats();
      expect(stats.allTimeMax).toBeGreaterThanOrEqual(0);
      expect(stats.allTimeMax).toBeLessThan(LOOP_LAG_WARN_MS);
    } finally {
      monitor.stop();
    }
  });

  it("warns once per window when max lag crosses the threshold, with a correlatable timestamp", async () => {
    const onWarn = vi.fn();
    const monitor = startLoopLagMonitor({ warnThresholdMs: 100, warnIntervalMs: 40, onWarn });
    try {
      // Let the histogram's libuv timer get scheduled before stalling it.
      await new Promise((resolve) => setTimeout(resolve, 20));
      blockEventLoop(250);
      // Give the warning timer a couple of ticks.
      await new Promise((resolve) => setTimeout(resolve, 150));

      expect(onWarn).toHaveBeenCalled();
      const [message, stats] = onWarn.mock.calls[0];
      expect(message).toContain("[loop-lag]");
      // The timestamp is the whole point — it is what lines a stall up against the
      // slow-request ring buffer and the monitor's phase log.
      expect(message).toContain(stats.windowStartedAt);
      expect(stats.max).toBeGreaterThanOrEqual(100);

      // The warning read-and-resets, so a single stall is reported once rather than on
      // every tick until the histogram happens to roll over.
      const callsAfterStall = onWarn.mock.calls.length;
      await new Promise((resolve) => setTimeout(resolve, 150));
      expect(onWarn.mock.calls.length).toBe(callsAfterStall);
    } finally {
      monitor.stop();
    }
  });

  it("stays quiet on an idle loop", async () => {
    const onWarn = vi.fn();
    const monitor = startLoopLagMonitor({ warnThresholdMs: LOOP_LAG_WARN_MS, warnIntervalMs: 30, onWarn });
    try {
      await new Promise((resolve) => setTimeout(resolve, 150));
      expect(onWarn).not.toHaveBeenCalled();
    } finally {
      monitor.stop();
    }
  });

  it("stop() halts the warning timer", async () => {
    const onWarn = vi.fn();
    const monitor = startLoopLagMonitor({ warnThresholdMs: 50, warnIntervalMs: 20, onWarn });
    await new Promise((resolve) => setTimeout(resolve, 20));
    blockEventLoop(150);
    monitor.stop();
    onWarn.mockClear();
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(onWarn).not.toHaveBeenCalled();
  });
});

describe("monitor phase timings (#347)", () => {
  /** Deterministic clock: each call advances by the next scripted step. */
  function scriptedClock(startMs: number, steps: number[]): () => number {
    let at = startMs;
    let index = 0;
    return () => {
      if (index > 0) at += steps[index - 1] ?? 0;
      index++;
      return at;
    };
  }

  it("records a duration per phase and names the slowest one", () => {
    // Clock reads: create(0), enter a(+10), enter b(+500), finish(+20)
    const recorder = createMonitorPhaseRecorder("starting", scriptedClock(1_000, [10, 500, 20]));
    recorder.enter("loading-candidates");
    recorder.enter("processing-candidates");
    const timings = recorder.finish();

    expect(timings.phases.map((p) => [p.phase, p.durationMs])).toEqual([
      ["starting", 10],
      ["loading-candidates", 500],
      ["processing-candidates", 20],
    ]);
    expect(timings.totalMs).toBe(530);
    // This is the payload's reason to exist: which phase to look at.
    expect(timings.slowestPhase).toEqual({
      phase: "loading-candidates",
      startedAt: new Date(1_010).toISOString(),
      durationMs: 500,
    });
    expect(timings.startedAt).toBe(new Date(1_000).toISOString());
    expect(timings.endedAt).toBe(new Date(1_530).toISOString());
  });

  it("ignores a repeated setPhase for the phase already running", () => {
    // Several call sites re-assert their phase; that must not add zero-length rows.
    const recorder = createMonitorPhaseRecorder("starting", scriptedClock(0, [5, 5, 5]));
    recorder.enter("starting");
    recorder.enter("starting");
    const timings = recorder.finish();

    expect(timings.phases).toHaveLength(1);
    expect(timings.phases[0].phase).toBe("starting");
  });

  it("records the single phase for a cycle that returns early", () => {
    // e.g. the maintenance-window / monitorShouldRun early return.
    const recorder = createMonitorPhaseRecorder("starting", scriptedClock(0, [7]));
    const timings = recorder.finish();

    expect(timings.phases).toEqual([{ phase: "starting", startedAt: new Date(0).toISOString(), durationMs: 7 }]);
    expect(timings.slowestPhase!.phase).toBe("starting");
    expect(timings.totalMs).toBe(7);
  });

  it("uses a real clock by default and produces non-negative durations", () => {
    const recorder = createMonitorPhaseRecorder("starting");
    recorder.enter("plugin-loops");
    const timings = recorder.finish();
    expect(timings.phases).toHaveLength(2);
    for (const phase of timings.phases) expect(phase.durationMs).toBeGreaterThanOrEqual(0);
    expect(timings.totalMs).toBeGreaterThanOrEqual(0);
  });
});
