/**
 * #359 — the monitor cycle must report what its spawned commands COST separately from what their
 * callbacks WAITED, and must carry an independent event-loop-delay reading to adjudicate the two.
 *
 * Why: `gitExec` measured from before the spawn to inside the `execFile` callback, which Node
 * delivers after stdio close and after everything else queued on the loop. So the per-operation
 * numbers this cycle payload exposes mixed command duration with queue wait under a name that
 * implied the former. That is what produced `rev-parse` averages of 9,231ms and 9,153ms on two
 * independent cycles — 1% apart, implausibly stable for disk work — while `blockingMs` read 0 and
 * a clean out-of-process harness measures `git --version` at 88-138ms on the same machine. It also
 * explains the dominant phase relocating four times between windows: the recorded cost follows
 * wherever the spawns cluster.
 *
 * The event-loop-delay figure is deliberately from `perf_hooks` rather than derived from any
 * operation we time — an instrument that shared the bias could not adjudicate it.
 */
import { describe, it, expect } from "vitest";
import { createMonitorPhaseRecorder } from "../lib/monitor-phase-timings.js";
import { recordOperation } from "@agentic-kanban/shared/lib/operation-metrics";

function blockEventLoop(ms: number): void {
  const until = Date.now() + ms;
  while (Date.now() < until) { /* deliberate spin */ }
}

describe("monitor cycle spawn-time split (#359)", () => {
  it("separates child-process time from callback queue wait", () => {
    const recorder = createMonitorPhaseRecorder("processing-candidates");
    // The live shape: many spawns whose recorded duration is dominated by waiting.
    recordOperation("git:rev-parse", 9_231, false, "cwd a", 90);
    recordOperation("git:rev-parse", 9_153, false, "cwd b", 95);
    const timings = recorder.finish();

    expect(timings.spawnTime.measuredCalls).toBe(2);
    expect(timings.spawnTime.childMs).toBe(185);
    expect(timings.spawnTime.queueMs).toBe(9_231 + 9_153 - 185);
    // The conclusion this makes statable: ~99% of the recorded "git time" was not git.
    expect(timings.spawnTime.queueMs).toBeGreaterThan(timings.spawnTime.childMs * 50);
  });

  it("reports zero queue wait for a synchronous spawn, which was always measured correctly", () => {
    const recorder = createMonitorPhaseRecorder("resource-sweep");
    recordOperation("git:status", 300, true, "cwd s", 300);
    const timings = recorder.finish();
    expect(timings.spawnTime.queueMs).toBe(0);
    expect(timings.blockingMs).toBe(300);
  });

  it("never reports a negative wait when a child time lands without its outer figure", () => {
    const recorder = createMonitorPhaseRecorder("plugin-loops");
    // Defensive: windows are opened and closed around phases, so a call can in principle
    // contribute one number to a window and not the other. A negative "wait" would be nonsense
    // and would silently poison the cycle total.
    recordOperation("git:log", 10, false, "cwd l", 500);
    expect(recorder.finish().spawnTime.queueMs).toBe(0);
  });

  it("carries an event-loop-delay reading that a blocked loop actually moves", async () => {
    const recorder = createMonitorPhaseRecorder("processing-candidates");
    // The histogram measures the interval BETWEEN loop turns, so the block has to sit between two
    // real turns — a spin inside a single synchronous turn is invisible to it (and, correctly, is
    // not a "delay" at all until something else needs the loop).
    await new Promise((resolve) => setTimeout(resolve, 30));
    blockEventLoop(150);
    await new Promise((resolve) => setTimeout(resolve, 30));
    const timings = recorder.finish();
    // Sampled off-thread by libuv, so it keeps measuring while JS is blocked — which is precisely
    // why it can distinguish "the command was slow" from "the callback waited".
    expect(timings.eventLoopDelay.maxMs).toBeGreaterThan(50);
    expect(timings.phases[0].eventLoopDelay.maxMs).toBeGreaterThan(50);
  });

  it("reports a delay object for every phase, so an inflated operation figure is attributable", () => {
    const recorder = createMonitorPhaseRecorder("starting");
    recorder.enter("loading-candidates");
    recorder.enter("processing-candidates");
    const timings = recorder.finish();
    expect(timings.phases).toHaveLength(3);
    for (const phase of timings.phases) {
      expect(phase.eventLoopDelay).toMatchObject({
        meanMs: expect.any(Number), maxMs: expect.any(Number), p99Ms: expect.any(Number),
      });
    }
  });
});
