import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  clearProbeYieldStreak,
  probeConsecutiveYields,
  probeGatePollIntervalMs,
  probeYieldStreakFloorMs,
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

  it("a bound of 0 disables preemption entirely — and says DISABLED, not budget-exhausted", () => {
    // The two both mean yield:false, but they are different facts and the log line differs.
    // Collapsed, a disabled bound logged "already yielded 0 time(s) in a row" on every tick —
    // untrue (no streak was spent) and alarming (it reads as a gate being made to wait).
    expect(shouldProbeYield({ gateWaiting: true, consecutiveYields: 0, maxConsecutiveYields: 0 })).toEqual({
      yield: false,
      reason: "disabled",
    });
    // ...and it wins over every other case, including "nobody is waiting".
    expect(shouldProbeYield({ gateWaiting: false, consecutiveYields: 9, maxConsecutiveYields: 0 }).reason)
      .toBe("disabled");
  });
});

describe("probeGatePollIntervalMs (#989)", () => {
  const POLL_ENV = "KANBAN_BASE_HEALTH_GATE_POLL_MS";
  afterEach(() => { delete process.env[POLL_ENV]; });

  it("defaults to 15s — small against a 45-minute verify, free to evaluate", () => {
    expect(probeGatePollIntervalMs()).toBe(15_000);
  });

  it("honors the env override and rejects a non-positive or garbage value", () => {
    process.env[POLL_ENV] = "50";
    expect(probeGatePollIntervalMs()).toBe(50);
    // A zero/negative interval would spin the event loop; fall back rather than obey it.
    process.env[POLL_ENV] = "0";
    expect(probeGatePollIntervalMs()).toBe(15_000);
    process.env[POLL_ENV] = "-5";
    expect(probeGatePollIntervalMs()).toBe(15_000);
    process.env[POLL_ENV] = "nope";
    expect(probeGatePollIntervalMs()).toBe(15_000);
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

describe("the streak floor (#989)", () => {
  const FLOOR_ENV = "KANBAN_BASE_HEALTH_YIELD_STREAK_FLOOR_MS";
  beforeEach(() => { resetProbeYieldStreaksForTests(); delete process.env[FLOOR_ENV]; });
  afterEach(() => { resetProbeYieldStreaksForTests(); delete process.env[FLOOR_ENV]; });

  it("defaults to 60s and honors an override, including 0", () => {
    expect(probeYieldStreakFloorMs()).toBe(60_000);
    process.env[FLOOR_ENV] = "5000";
    expect(probeYieldStreakFloorMs()).toBe(5000);
    process.env[FLOOR_ENV] = "0";
    expect(probeYieldStreakFloorMs()).toBe(0);
    process.env[FLOOR_ENV] = "junk";
    expect(probeYieldStreakFloorMs()).toBe(60_000);
  });

  it("a yield below the floor does not consume budget", () => {
    // Three seconds of discarded verify is not the thing the escape exists to bound: the probe
    // barely started and re-runs cheaply. Counting it would let a merge train burn the budget
    // with free yields and then force a full run through the train.
    expect(recordProbeYield("p1", 3_000)).toBe(0);
    expect(recordProbeYield("p1", 3_000)).toBe(0);
    expect(probeConsecutiveYields("p1")).toBe(0);
  });

  it("a yield at or above the floor counts", () => {
    expect(recordProbeYield("p1", 60_000)).toBe(1);
    expect(recordProbeYield("p1", 10 * 60_000)).toBe(2);
  });

  it("an untimed yield always counts — a caller with no timing gets the pre-floor behaviour", () => {
    expect(recordProbeYield("p1")).toBe(1);
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
