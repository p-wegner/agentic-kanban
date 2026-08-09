/**
 * #359 — the per-operation git timings measured the WRONG THING, and every conclusion drawn from
 * them is suspect.
 *
 * `gitExec` took `Date.now()` before spawning and read it again INSIDE the `execFile` callback,
 * which Node delivers only after stdio close and after whatever else is queued on the event loop.
 * The recorded number was therefore command duration PLUS callback queue wait, reported under a
 * name that implies the former. With ~130 spawns in a monitor cycle that inflates arbitrarily, and
 * it explains every symptom that never fitted a "git is slow" story:
 *
 *  - `rev-parse` averaging 9,231ms and 9,153ms on two independent cycles — 1% apart, implausibly
 *    stable for disk work, exactly what average queue depth looks like;
 *  - `blockingMs: 0` on every cycle (nothing blocks synchronously — work QUEUES);
 *  - the dominant phase relocating four times across windows (recorded cost follows the spawns);
 *  - bimodal `/api/health` (fast idle, slow when the loop is saturated).
 *
 * Independently: git is genuinely fast on this machine — `git --version` measures 88-138ms from a
 * clean out-of-process harness, and the adapter uses `execFile` with no `shell: true`, so it never
 * pays the MSYS fork cost that corrupted an earlier bash-based measurement.
 *
 * These tests lock the SPLIT, not a latency budget: a wall-clock threshold here would be exactly
 * the kind of load-sensitive assertion that produced the bad numbers in the first place.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { gitExec, gitExecSync } from "../src/lib/git-exec.js";
import { recordOperation, resetOperationsForTest, snapshotOperations } from "../src/lib/operation-metrics.js";

beforeEach(() => resetOperationsForTest());

describe("gitExec records the child's own lifetime, not just call-to-callback", () => {
  it("reports a child lifetime for an async spawn, bounded by the call-to-callback figure", async () => {
    const result = await gitExec(["--version"], {});
    expect(result.code).toBe(0);

    const stat = snapshotOperations()["git:--version"] ?? snapshotOperations()["git:unknown"];
    expect(stat).toBeDefined();
    expect(stat.calls).toBe(1);
    // The whole point: the child time is now a SEPARATE, attributable number.
    expect(stat.childMeasuredCalls).toBe(1);
    // The child exits before its callback runs, so its lifetime can never exceed the outer figure.
    expect(stat.childMs).toBeLessThanOrEqual(stat.totalMs);
    expect(stat.childMs).toBeGreaterThanOrEqual(0);
  });

  it("a SYNC spawn reports child time equal to its wall clock — there is no callback to wait for", () => {
    // `gitExecSync` was always accurate (it brackets the synchronous call), and reporting the same
    // value in both slots is what makes `totalMs - childMs` mean "queue wait" uniformly: it must
    // read 0 for a sync call and isolate the async wait.
    gitExecSync(["--version"], { cwd: process.cwd() });
    const snap = snapshotOperations();
    const label = Object.keys(snap).find((k) => k.startsWith("git:"));
    expect(label).toBeDefined();
    const stat = snap[label!];
    expect(stat.blockingCalls).toBe(1);
    expect(stat.childMeasuredCalls).toBe(1);
    expect(stat.childMs).toBe(stat.totalMs);
  });

  it("keeps the two numbers independent, so a queue-inflated call is visibly inflated", () => {
    // The synthetic version of the live observation: a 90ms command recorded as a 9.2s call.
    // Before the split there was no way to state that from the metrics at all.
    recordOperation("git:rev-parse", 9_231, false, "k1", 90);
    const stat = snapshotOperations()["git:rev-parse"];
    expect(stat.childMs).toBe(90);
    expect(stat.totalMs - stat.childMs).toBe(9_141);
  });
});
