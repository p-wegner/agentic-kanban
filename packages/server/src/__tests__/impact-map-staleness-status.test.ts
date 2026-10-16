import { beforeEach, describe, expect, it } from "vitest";
import {
  GATE_STALE_WARN_INTERVAL_MS,
  recordImpactMapStatus,
  resetImpactMapStatusForTests,
  shouldWarnGateStale,
} from "../services/test-impact-map/staleness-status.js";

describe("#1519 impact-map staleness status", () => {
  beforeEach(() => resetImpactMapStatusForTests());

  it("records a status line only when it changes", () => {
    expect(recordImpactMapStatus("p", "a")).toBe(true);
    expect(recordImpactMapStatus("p", "a")).toBe(false);
    expect(recordImpactMapStatus("p", "b")).toBe(true);
  });

  it("rate-limits the per-gate STALE warning", () => {
    const now = Date.now();
    expect(shouldWarnGateStale(now)).toBe(true);
    expect(shouldWarnGateStale(now + 1000)).toBe(false);
    expect(shouldWarnGateStale(now + GATE_STALE_WARN_INTERVAL_MS)).toBe(true);
  });
});
