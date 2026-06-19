import { describe, it, expect } from "vitest";
import {
  aggregateProviderMix,
  aggregateCostOverTime,
  bucketScorecardScores,
} from "./workspace-stats.js";

const DATES = ["2026-06-01", "2026-06-02", "2026-06-03"];

describe("aggregateProviderMix", () => {
  it("counts workspaces per day per provider with a stable sorted series", () => {
    const { series, points } = aggregateProviderMix(
      [
        { provider: "codex", createdAt: "2026-06-01T10:00:00Z" },
        { provider: "claude", createdAt: "2026-06-01T11:00:00Z" },
        { provider: "codex", createdAt: "2026-06-02T09:00:00Z" },
      ],
      DATES,
    );
    expect(series).toEqual(["claude", "codex"]);
    expect(points).toEqual([
      { date: "2026-06-01", counts: { claude: 1, codex: 1 } },
      { date: "2026-06-02", counts: { claude: 0, codex: 1 } },
      { date: "2026-06-03", counts: { claude: 0, codex: 0 } },
    ]);
  });

  it("maps a null provider to 'unknown' and skips rows with no createdAt", () => {
    const { series, points } = aggregateProviderMix(
      [
        { provider: null, createdAt: "2026-06-01T00:00:00Z" },
        { provider: "codex", createdAt: null },
      ],
      DATES,
    );
    expect(series).toEqual(["codex", "unknown"]);
    expect(points[0].counts).toEqual({ codex: 0, unknown: 1 });
  });

  it("ignores rows whose day falls outside the axis window", () => {
    const { points } = aggregateProviderMix(
      [{ provider: "codex", createdAt: "2025-01-01T00:00:00Z" }],
      DATES,
    );
    expect(points.every((p) => p.counts.codex === 0)).toBe(true);
  });
});

describe("aggregateCostOverTime", () => {
  it("sums stats.totalCostUsd per day per provider", () => {
    const { series, points } = aggregateCostOverTime(
      [
        { provider: "codex", startedAt: "2026-06-01T10:00:00Z", stats: JSON.stringify({ totalCostUsd: 1.5 }) },
        { provider: "codex", startedAt: "2026-06-01T12:00:00Z", stats: JSON.stringify({ totalCostUsd: 0.5 }) },
        { provider: "claude", startedAt: "2026-06-02T08:00:00Z", stats: JSON.stringify({ totalCostUsd: 3 }) },
      ],
      DATES,
    );
    expect(series).toEqual(["claude", "codex"]);
    expect(points[0].costs).toEqual({ claude: 0, codex: 2 });
    expect(points[1].costs).toEqual({ claude: 3, codex: 0 });
  });

  it("skips rows with no stats, unparseable stats, zero cost, or non-finite cost", () => {
    const { points } = aggregateCostOverTime(
      [
        { provider: "codex", startedAt: "2026-06-01T10:00:00Z", stats: null },
        { provider: "codex", startedAt: "2026-06-01T10:00:00Z", stats: "{not json" },
        { provider: "codex", startedAt: "2026-06-01T10:00:00Z", stats: JSON.stringify({ totalCostUsd: 0 }) },
        { provider: "codex", startedAt: "2026-06-01T10:00:00Z", stats: JSON.stringify({ totalCostUsd: "NaN" }) },
        { provider: "codex", startedAt: null, stats: JSON.stringify({ totalCostUsd: 9 }) },
      ],
      DATES,
    );
    expect(points.every((p) => Object.values(p.costs).every((v) => v === 0))).toBe(true);
  });
});

describe("bucketScorecardScores", () => {
  it("distributes scores across the 5 ranges with 100 in the top bucket", () => {
    const { buckets, total } = bucketScorecardScores([
      { score: 0 },
      { score: 19 },
      { score: 20 },
      { score: 55 },
      { score: 79 },
      { score: 80 },
      { score: 100 },
      { score: null },
    ]);
    expect(total).toBe(8);
    expect(buckets).toEqual([
      { range: "0-20", count: 3 }, // 0, 19, null(->0)
      { range: "20-40", count: 1 }, // 20
      { range: "40-60", count: 1 }, // 55
      { range: "60-80", count: 1 }, // 79
      { range: "80-100", count: 2 }, // 80, 100
    ]);
  });

  it("returns all-zero buckets for an empty input", () => {
    const { buckets, total } = bucketScorecardScores([]);
    expect(total).toBe(0);
    expect(buckets.every((b) => b.count === 0)).toBe(true);
  });
});
