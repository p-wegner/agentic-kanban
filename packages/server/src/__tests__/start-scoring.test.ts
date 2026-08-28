// #917 — scored ticket selection: unit tests for the pure scoring module.
import { describe, it, expect } from "vitest";
import { computeStartScore, hoursSince, matchBullseyeSegment, PRIORITY_WEIGHTS } from "../lib/start-scoring.js";
import type { StrategyBullseyeSegment } from "@agentic-kanban/shared/lib/strategy-objective-file";

describe("computeStartScore", () => {
  it("gives a high-priority ticket a higher score than a low-priority one, all else equal", () => {
    const high = computeStartScore({ priority: "high", unblockCount: 0, ageHours: 0 });
    const low = computeStartScore({ priority: "low", unblockCount: 0, ageHours: 0 });
    expect(high.score).toBeGreaterThan(low.score);
  });

  it("acceptance criterion: a high ticket that unblocks 3 others outranks a low leaf", () => {
    const highUnblocker = computeStartScore({ priority: "high", unblockCount: 3, ageHours: 1 });
    const lowLeaf = computeStartScore({ priority: "low", unblockCount: 0, ageHours: 1 });
    expect(highUnblocker.score).toBeGreaterThan(lowLeaf.score);
  });

  it("multiplies score by (1 + unblockCount)", () => {
    const zero = computeStartScore({ priority: "medium", unblockCount: 0, ageHours: 0 });
    const three = computeStartScore({ priority: "medium", unblockCount: 3, ageHours: 0 });
    expect(three.score).toBeCloseTo(zero.score * 4, 10);
  });

  it("starvation guard: age grows the score so an old ticket eventually outranks a fresher higher-priority one", () => {
    const freshHigh = computeStartScore({ priority: "high", unblockCount: 0, ageHours: 0 });
    const ancientLow = computeStartScore({ priority: "low", unblockCount: 0, ageHours: 24 * 30 });
    expect(ancientLow.score).toBeGreaterThan(freshHigh.score);
  });

  it("defaults predictedCost to 1 (neutral) when absent", () => {
    const absent = computeStartScore({ priority: "medium", unblockCount: 0, ageHours: 0 });
    const explicit = computeStartScore({ priority: "medium", unblockCount: 0, ageHours: 0, predictedCost: 1 });
    expect(absent.score).toBe(explicit.score);
    expect(absent.predictedCost).toBe(1);
  });

  it("a cheaper predicted cost scores higher for the same priority/unblock/age", () => {
    const cheap = computeStartScore({ priority: "medium", unblockCount: 0, ageHours: 0, predictedCost: 1 });
    const expensive = computeStartScore({ priority: "medium", unblockCount: 0, ageHours: 0, predictedCost: 4 });
    expect(cheap.score).toBeGreaterThan(expensive.score);
  });

  it("ignores a non-positive predictedCost and falls back to neutral", () => {
    const zeroCost = computeStartScore({ priority: "medium", unblockCount: 0, ageHours: 0, predictedCost: 0 });
    const neutral = computeStartScore({ priority: "medium", unblockCount: 0, ageHours: 0 });
    expect(zeroCost.predictedCost).toBe(1);
    expect(zeroCost.score).toBe(neutral.score);
  });

  it("applies the bullseye multiplier directly to the score", () => {
    const base = computeStartScore({ priority: "medium", unblockCount: 0, ageHours: 0 });
    const boosted = computeStartScore({ priority: "medium", unblockCount: 0, ageHours: 0, bullseyeMultiplier: 5 });
    expect(boosted.score).toBeCloseTo(base.score * 5, 10);
  });

  it("normalizes a negative unblockCount to 0", () => {
    const result = computeStartScore({ priority: "medium", unblockCount: -5, ageHours: 0 });
    expect(result.unblockCount).toBe(0);
  });

  it("priority weights are strictly ordered critical > high > medium > low", () => {
    expect(PRIORITY_WEIGHTS.critical).toBeGreaterThan(PRIORITY_WEIGHTS.high);
    expect(PRIORITY_WEIGHTS.high).toBeGreaterThan(PRIORITY_WEIGHTS.medium);
    expect(PRIORITY_WEIGHTS.medium).toBeGreaterThan(PRIORITY_WEIGHTS.low);
  });
});

describe("hoursSince", () => {
  it("returns 0 for a null/undefined timestamp", () => {
    expect(hoursSince(null, Date.now())).toBe(0);
    expect(hoursSince(undefined, Date.now())).toBe(0);
  });

  it("returns 0 for an unparseable timestamp", () => {
    expect(hoursSince("not-a-date", Date.now())).toBe(0);
  });

  it("computes elapsed hours between an ISO timestamp and now", () => {
    const nowMs = Date.parse("2026-01-02T00:00:00.000Z");
    const from = "2026-01-01T00:00:00.000Z";
    expect(hoursSince(from, nowMs)).toBeCloseTo(24, 5);
  });

  it("floors at 0 for a timestamp in the future", () => {
    const nowMs = Date.parse("2026-01-01T00:00:00.000Z");
    const from = "2026-01-02T00:00:00.000Z";
    expect(hoursSince(from, nowMs)).toBe(0);
  });
});

describe("matchBullseyeSegment", () => {
  const segments: StrategyBullseyeSegment[] = [
    { id: "seg-bug", kind: "work-type", label: "Bugs", weight: 5, keywords: "bug, fix, defect" },
    { id: "seg-feature", kind: "work-type", label: "Features", weight: 3, keywords: "feature" },
    { id: "seg-provider", kind: "provider", label: "Claude", weight: 5, provider: "claude" },
    { id: "seg-empty", kind: "area", label: "Empty", weight: 4, keywords: "" },
  ];

  it("matches a work-type segment by keyword in the title and returns its weight", () => {
    const { multiplier, segmentId } = matchBullseyeSegment({ title: "Fix login bug", description: null }, segments);
    expect(segmentId).toBe("seg-bug");
    expect(multiplier).toBe(5);
  });

  it("picks the highest-weight match when multiple segments match", () => {
    const { segmentId } = matchBullseyeSegment({ title: "bug feature combo", description: null }, segments);
    expect(segmentId).toBe("seg-bug");
  });

  it("returns neutral (multiplier 1, segmentId null) when nothing matches", () => {
    const { multiplier, segmentId } = matchBullseyeSegment({ title: "Unrelated ticket", description: null }, segments);
    expect(multiplier).toBe(1);
    expect(segmentId).toBeNull();
  });

  it("ignores provider-kind segments even if their keywords would match", () => {
    const { segmentId } = matchBullseyeSegment({ title: "claude related work", description: null }, segments);
    expect(segmentId).not.toBe("seg-provider");
  });

  it("ignores a segment with empty keywords", () => {
    const { segmentId } = matchBullseyeSegment({ title: "nothing to match here", description: null }, segments);
    expect(segmentId).not.toBe("seg-empty");
  });

  it("matches against description and issueType too", () => {
    const { segmentId } = matchBullseyeSegment(
      { title: "Ticket", description: "this is a defect report", issueType: "task" },
      segments,
    );
    expect(segmentId).toBe("seg-bug");
  });
});
