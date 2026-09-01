import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  clearProbeYieldStreak,
  probeConsecutiveYields,
  probeMaxConsecutiveYields,
  recordProbeYield,
  resetProbeYieldStreaksForTests,
  shouldProbeYield,
} from "../services/base-health-probe-preemption.js";

const ENV = "KANBAN_BASE_HEALTH_MAX_CONSECUTIVE_YIELDS";

/**
 * #989 — item 3 of #978. A RUNNING base-health probe holds the box's one verify slot for up to
 * clone 5m + install 15m + verify 45m, so a merge gate arriving a minute in waits it out. The
 * probe therefore abandons its run at a stage boundary when a gate is queued — and the anti-thrash
 * bound is what keeps that from becoming "the base is never measured".
 */
describe("shouldProbeYield (#989)", () => {
  beforeEach(() => { resetProbeYieldStreaksForTests(); delete process.env[ENV]; });
  afterEach(() => { resetProbeYieldStreaksForTests(); delete process.env[ENV]; });

  it("does not yield when nothing is waiting — the common case costs nothing", () => {
    expect(shouldProbeYield({ gateWaiting: false, consecutiveYields: 0 })).toEqual({
      yield: false,
      reason: "no_gate_waiting",
    });
  });

  it("yields to a waiting gate: a person is blocked, this is a background measurement", () => {
    expect(shouldProbeYield({ gateWaiting: true, consecutiveYields: 0 })).toEqual({
      yield: true,
      reason: "gate_waiting",
    });
  });

  it("keeps yielding up to the bound, then runs to completion", () => {
    const max = 3;
    for (let i = 0; i < max; i++) {
      expect(shouldProbeYield({ gateWaiting: true, consecutiveYields: i, maxConsecutiveYields: max }).yield).toBe(true);
    }
    // The escape: a board merging steadily would otherwise preempt every probe forever, which is
    // the exact starvation #978's priority classes needed a bound for.
    expect(shouldProbeYield({ gateWaiting: true, consecutiveYields: max, maxConsecutiveYields: max })).toEqual({
      yield: false,
      reason: "yield_budget_exhausted",
    });
    expect(shouldProbeYield({ gateWaiting: true, consecutiveYields: max + 5, maxConsecutiveYields: max }).yield).toBe(false);
  });

  it("distinguishes 'nobody waiting' from 'budget exhausted' — a silent abort is what this ticket forbids", () => {
    // Both return yield:false, but only one of them means a gate is being made to wait. The
    // reason is what the log line reads, and a probe that is repeatedly preempted must be visible.
    expect(shouldProbeYield({ gateWaiting: false, consecutiveYields: 9 }).reason).toBe("no_gate_waiting");
    expect(shouldProbeYield({ gateWaiting: true, consecutiveYields: 9, maxConsecutiveYields: 3 }).reason)
      .toBe("yield_budget_exhausted");
  });

  it("a bound of 0 disables preemption entirely — the pre-#989 behaviour, on demand", () => {
    expect(shouldProbeYield({ gateWaiting: true, consecutiveYields: 0, maxConsecutiveYields: 0 })).toEqual({
      yield: false,
      reason: "yield_budget_exhausted",
    });
  });
});

describe("probeMaxConsecutiveYields (#989)", () => {
  afterEach(() => { delete process.env[ENV]; });

  it("defaults to 3 — one would make the escape fire constantly on a board that merges in bursts", () => {
    expect(probeMaxConsecutiveYields()).toBe(3);
  });

  it("honors the env override, including 0", () => {
    process.env[ENV] = "7";
    expect(probeMaxConsecutiveYields()).toBe(7);
    process.env[ENV] = "0";
    expect(probeMaxConsecutiveYields()).toBe(0);
  });

  it("falls back to the default on garbage or a negative value", () => {
    process.env[ENV] = "not-a-number";
    expect(probeMaxConsecutiveYields()).toBe(3);
    process.env[ENV] = "-2";
    expect(probeMaxConsecutiveYields()).toBe(3);
  });
});

describe("the consecutive-yield streak (#989)", () => {
  beforeEach(() => resetProbeYieldStreaksForTests());
  afterEach(() => resetProbeYieldStreaksForTests());

  it("starts at zero and counts up per project, independently", () => {
    expect(probeConsecutiveYields("p1")).toBe(0);
    expect(recordProbeYield("p1")).toBe(1);
    expect(recordProbeYield("p1")).toBe(2);
    // A busy project must not spend another project's yield budget.
    expect(probeConsecutiveYields("p2")).toBe(0);
  });

  it("clears on a completed run — 'consecutive' is the whole point of the bound", () => {
    recordProbeYield("p1");
    recordProbeYield("p1");
    clearProbeYieldStreak("p1");
    expect(probeConsecutiveYields("p1")).toBe(0);
    // ...so a probe that yields, completes, then yields again is never pushed into the escape by
    // an accumulated total that no longer describes anything.
    expect(shouldProbeYield({ gateWaiting: true, consecutiveYields: probeConsecutiveYields("p1") }).yield).toBe(true);
  });

  it("drives the escape end to end: yield, yield, yield, then run", () => {
    const max = 3;
    const decide = (p: string) =>
      shouldProbeYield({ gateWaiting: true, consecutiveYields: probeConsecutiveYields(p), maxConsecutiveYields: max });

    for (let i = 0; i < max; i++) {
      expect(decide("p1").yield).toBe(true);
      recordProbeYield("p1");
    }
    expect(decide("p1")).toEqual({ yield: false, reason: "yield_budget_exhausted" });

    // That run completes and clears the streak, so the next gate can preempt again.
    clearProbeYieldStreak("p1");
    expect(decide("p1").yield).toBe(true);
  });
});
