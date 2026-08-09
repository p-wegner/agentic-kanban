import { beforeEach, describe, expect, it } from "vitest";
import {
  diffOperations,
  recordOperation,
  resetOperationsForTest,
  snapshotOperations,
  topOperations,
} from "../src/lib/operation-metrics.js";

/**
 * #359 — the per-operation registry that has to exist before any fix to that ticket can be judged.
 *
 * Per-phase timing gave three different confident answers about "the" blocker across three windows
 * on one quiet machine (`processing-candidates` 92%, then `compounding-setup` 40%, then cycles
 * growing 105s -> 180s -> 222s). The properties tested here are the ones that make the successor
 * measurement trustworthy: a window's numbers must be a DIFF (so an earlier phase's cost is never
 * charged to a later one), and blocking time must be separable from wall clock (60s of awaited git
 * and 60s of `execFileSync` cost the same wall clock and have nothing else in common).
 */
beforeEach(() => resetOperationsForTest());

describe("recordOperation / snapshotOperations", () => {
  it("accumulates calls, total and max", () => {
    recordOperation("git:status", 10);
    recordOperation("git:status", 40);
    expect(snapshotOperations()["git:status"]).toEqual({
      calls: 2, totalMs: 50, maxMs: 40, blockingCalls: 0, blockingMs: 0,
      // #359: a call that reported no child lifetime must not be counted in the child-time
      // denominator — otherwise the child/queue split would read as "0ms of child time" rather
      // than "not measured".
      childMs: 0, maxChildMs: 0, childMeasuredCalls: 0,
    });
  });

  it("records the child-process lifetime separately from call-to-callback (#359)", () => {
    // The defect this splits apart: the async git adapter timed from BEFORE the spawn to INSIDE
    // the execFile callback, which Node delivers after stdio close and after whatever else is
    // queued on the loop. So a 90ms git process on a congested loop was recorded as a
    // multi-second git call — the shape behind `rev-parse` averaging 9,231ms and 9,153ms across
    // two independent cycles with `blockingMs: 0`, while an out-of-process harness measures
    // `git --version` at 88-138ms on the same machine.
    recordOperation("git:rev-parse", 9_200, false, "cwd rev-parse HEAD", 90);
    recordOperation("git:rev-parse", 100, false, "cwd rev-parse other", 80);
    const stat = snapshotOperations()["git:rev-parse"];
    expect(stat.totalMs).toBe(9_300);
    expect(stat.childMs).toBe(170);
    expect(stat.maxChildMs).toBe(90);
    expect(stat.childMeasuredCalls).toBe(2);
    // The number that was previously invisible: almost all of the recorded "git time" was waiting.
    expect(stat.totalMs - stat.childMs).toBe(9_130);
  });

  it("tracks blocking calls separately from wall clock", () => {
    recordOperation("git:status", 100, true);
    recordOperation("git:status", 100, false);
    const stat = snapshotOperations()["git:status"];
    expect(stat.totalMs).toBe(200);
    // The number that explains a bimodal /api/health: only half of that wall clock held the loop.
    expect(stat.blockingMs).toBe(100);
    expect(stat.blockingCalls).toBe(1);
  });

  it("returns a COPY, so a held snapshot is not mutated by later calls", () => {
    recordOperation("git:status", 10);
    const before = snapshotOperations();
    recordOperation("git:status", 10);
    expect(before["git:status"].calls).toBe(1);
  });
});

describe("diffOperations", () => {
  it("reports only what happened inside the window", () => {
    recordOperation("git:status", 500);
    const before = snapshotOperations();
    recordOperation("git:status", 20);
    recordOperation("db:getPreference", 3);
    const diff = diffOperations(before, snapshotOperations());
    expect(diff["git:status"]).toMatchObject({ calls: 1, totalMs: 20 });
    expect(diff["db:getPreference"]).toMatchObject({ calls: 1, totalMs: 3 });
  });

  it("omits labels with no calls in the window rather than reporting zeros", () => {
    recordOperation("git:status", 5);
    const before = snapshotOperations();
    recordOperation("db:getPreference", 1);
    expect(Object.keys(diffOperations(before, snapshotOperations()))).toEqual(["db:getPreference"]);
  });

  it("does NOT attribute an earlier window's worst call to this one", () => {
    // The whole reason maxMs is special-cased: a cumulative max cannot be differenced, and
    // charging a previous phase's 9-second git call to a quiet phase is exactly the
    // misattribution that made per-phase timing untrustworthy.
    recordOperation("git:status", 9000);
    const before = snapshotOperations();
    recordOperation("git:status", 12);
    expect(diffOperations(before, snapshotOperations())["git:status"].maxMs).toBe(0);
  });

  it("reports the window's max when the window set a new high-water mark", () => {
    recordOperation("git:status", 10);
    const before = snapshotOperations();
    recordOperation("git:status", 4000);
    expect(diffOperations(before, snapshotOperations())["git:status"].maxMs).toBe(4000);
  });

  it("handles a label that did not exist in the earlier snapshot", () => {
    const before = snapshotOperations();
    recordOperation("exec:powershell.exe", 8000, false);
    expect(diffOperations(before, snapshotOperations())["exec:powershell.exe"].calls).toBe(1);
  });
});

describe("topOperations", () => {
  it("orders by total time, worst first, and truncates", () => {
    recordOperation("git:status", 100);
    recordOperation("db:getPreference", 900);
    recordOperation("exec:netstat", 50);
    const top = topOperations(diffOperations({}, snapshotOperations()), 2);
    expect(top.map((t) => t.label)).toEqual(["db:getPreference", "git:status"]);
  });
});
