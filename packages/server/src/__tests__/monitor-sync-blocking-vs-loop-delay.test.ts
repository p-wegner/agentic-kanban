/**
 * #368 point 3 — `blockingMs: 0` in every phase was reported as contradicting the SAME cycle's
 * `eventLoopDelay` maxMs of 11241 / 21274 / 12910, with the conclusion "one of these two instruments
 * is wrong".
 *
 * Neither measurement was wrong. The NAME and the documented claim of `blockingMs` were: it summed
 * only the calls this codebase records with `blocking: true` (`gitExecSync`, a synchronous file
 * read), while its doc comment presented it as the figure that explains a blocked event loop. So
 * anything that stalls the process WITHOUT passing through `recordOperation` — the OS descheduling
 * the process, a filter driver holding an IO, GC, native work inside a dependency — contributed
 * exactly zero, and a reader was invited to conclude the loop was healthy while it was stalled for
 * eleven seconds. It is now `syncBlockingMs`, and `eventLoopDelay` is the authority on loop health.
 *
 * These tests demonstrate the two are not contradictory: they lock the case where the loop is
 * provably stalled and `syncBlockingMs` is provably zero, which is the exact live shape.
 */
import { describe, it, expect } from "vitest";
import { createMonitorPhaseRecorder } from "../lib/monitor-phase-timings.js";
import { recordOperation } from "@agentic-kanban/shared/lib/operation-metrics";

function blockEventLoop(ms: number): void {
  const until = Date.now() + ms;
  while (Date.now() < until) { /* deliberate spin */ }
}

describe("syncBlockingMs vs eventLoopDelay (#368)", () => {
  it("reports zero sync-blocking time and a large loop delay for the SAME window — not a contradiction", async () => {
    const recorder = createMonitorPhaseRecorder("processing-candidates");
    // An uninstrumented stall: nothing here goes through `recordOperation`, which is what an OS-level
    // or filter-driver stall looks like from inside the process.
    await new Promise((resolve) => setTimeout(resolve, 30));
    blockEventLoop(200);
    await new Promise((resolve) => setTimeout(resolve, 30));
    const timings = recorder.finish();

    expect(timings.syncBlockingMs).toBe(0);
    expect(timings.eventLoopDelay.maxMs).toBeGreaterThan(100);
    expect(timings.phases[0].syncBlockingMs).toBe(0);
    expect(timings.phases[0].eventLoopDelay.maxMs).toBeGreaterThan(100);
  });

  it("counts a call only when it was recorded as synchronous, which is all it ever claimed to count", () => {
    const recorder = createMonitorPhaseRecorder("resource-sweep");
    recordOperation("git:status", 300, true, "cwd s", 300);
    recordOperation("git:rev-parse", 9_000, false, "cwd r", 90);
    const timings = recorder.finish();
    expect(timings.syncBlockingMs).toBe(300);
  });
});

describe("child/queue split is per-call, not per-label (#368 point 4)", () => {
  it("does not let a call that never spawned donate its whole duration to the queue side", () => {
    const recorder = createMonitorPhaseRecorder("processing-candidates");
    // A real spawn: 9s recorded, 90ms of actual child.
    recordOperation("git:rev-parse", 9_000, false, "cwd a", 90);
    // Same label, no child lifetime — the ENOENT shape: no `exit` event, so no `childMs`. Before the
    // fix this call's whole 5s was paired with the label's `childMs` and read as queue wait, i.e. the
    // split's headline number was inflated by calls that never had a child at all.
    recordOperation("git:rev-parse", 5_000, false, "cwd b");
    const timings = recorder.finish();

    expect(timings.spawnTime.measuredCalls).toBe(1);
    expect(timings.spawnTime.childMs).toBe(90);
    expect(timings.spawnTime.queueMs).toBe(9_000 - 90);
  });

  it("still reports zero queue wait for a synchronous spawn", () => {
    const recorder = createMonitorPhaseRecorder("resource-sweep");
    recordOperation("git:status", 300, true, "cwd s", 300);
    expect(recorder.finish().spawnTime.queueMs).toBe(0);
  });
});
