// #416: idle-window gating for the diagnostic health-warning refresh (extends #349).
// The scan has no deadline — nothing in the cycle reads its output — so it should start
// only in a genuinely idle window (no cycle in flight, calm event loop), but deferral is
// capped so a permanently-busy board still refreshes its warnings eventually.

import { describe, expect, it } from "vitest";
import {
  shouldStartHealthRefresh,
  HEALTH_WARNING_DEFER_CAP_MS,
  CALM_LOOP_MAX_P90_MS,
} from "../startup/health-refresh-gate.js";

const INTERVAL_MS = 10 * 60_000;

function base(overrides: Partial<Parameters<typeof shouldStartHealthRefresh>[0]> = {}) {
  return {
    nowMs: 100 * 60_000,
    lastStartedAtMs: 100 * 60_000 - INTERVAL_MS - 1, // interval elapsed
    refreshRunning: false,
    intervalMs: INTERVAL_MS,
    cycleInFlight: false,
    loopLagP90Ms: 0,
    ...overrides,
  };
}

describe("shouldStartHealthRefresh (#416)", () => {
  it("runs when the interval elapsed, no cycle is in flight and the loop is calm", () => {
    expect(shouldStartHealthRefresh(base())).toBe(true);
  });

  it("respects the #349 rate limit inside the interval", () => {
    expect(shouldStartHealthRefresh(base({ lastStartedAtMs: base().nowMs - INTERVAL_MS + 1 }))).toBe(false);
  });

  it("defers while a monitor cycle is in flight", () => {
    expect(shouldStartHealthRefresh(base({ cycleInFlight: true }))).toBe(false);
  });

  it("defers under a busy event loop (p90 above the calm threshold)", () => {
    expect(shouldStartHealthRefresh(base({ loopLagP90Ms: CALM_LOOP_MAX_P90_MS + 1 }))).toBe(false);
  });

  it("runs at exactly the calm threshold", () => {
    expect(shouldStartHealthRefresh(base({ loopLagP90Ms: CALM_LOOP_MAX_P90_MS }))).toBe(true);
  });

  it("treats an absent lag monitor (null) as calm", () => {
    expect(shouldStartHealthRefresh(base({ loopLagP90Ms: null }))).toBe(true);
  });

  it("runs after the deferral cap even under a busy loop AND an in-flight cycle", () => {
    expect(shouldStartHealthRefresh(base({
      lastStartedAtMs: base().nowMs - HEALTH_WARNING_DEFER_CAP_MS,
      cycleInFlight: true,
      loopLagP90Ms: 5000,
    }))).toBe(true);
  });

  it("never-started (lastStartedAtMs 0) runs immediately — matching #349 boot behavior", () => {
    expect(shouldStartHealthRefresh(base({ lastStartedAtMs: 0, cycleInFlight: true, loopLagP90Ms: 5000 }))).toBe(true);
  });

  it("single-flight blocks everything, including force", () => {
    expect(shouldStartHealthRefresh(base({ refreshRunning: true, force: true }))).toBe(false);
  });

  it("force bypasses the interval and idle checks (but not single-flight)", () => {
    expect(shouldStartHealthRefresh(base({
      lastStartedAtMs: base().nowMs - 1,
      cycleInFlight: true,
      loopLagP90Ms: 5000,
      force: true,
    }))).toBe(true);
  });
});
