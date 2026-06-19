import { describe, expect, it } from "vitest";
import {
  computeThroughputByProvider,
  percentile,
  type ThroughputAttributionRow,
} from "./dashboard-analytics.service.js";

const DAY = 24 * 60 * 60 * 1000;

function row(over: Partial<ThroughputAttributionRow> = {}): ThroughputAttributionRow {
  return {
    issueId: "i1",
    issueCreatedAt: "2026-01-01T00:00:00.000Z",
    statusChangedAt: "2026-01-02T00:00:00.000Z", // 1 day lead
    provider: "claude",
    claudeProfile: "anth",
    mergedAt: "2026-01-02T00:00:00.000Z",
    ...over,
  };
}

describe("percentile", () => {
  it("returns null for an empty array", () => {
    expect(percentile([], 50)).toBeNull();
  });
  it("interpolates the median", () => {
    expect(percentile([10, 20, 30], 50)).toBe(20);
    expect(percentile([10, 20], 50)).toBe(15);
  });
});

describe("computeThroughputByProvider", () => {
  it("groups by provider:profile and counts merged issues", () => {
    const result = computeThroughputByProvider(
      [
        row({ issueId: "a", provider: "claude", claudeProfile: "anth" }),
        row({ issueId: "b", provider: "claude", claudeProfile: "anth" }),
        row({ issueId: "c", provider: "codex", claudeProfile: "" }),
      ],
      14,
    );
    expect(result.window).toBe("14d");
    expect(result.providers[0]).toMatchObject({ provider: "claude", profile: "anth", count: 2 });
    expect(result.providers.find((p) => p.provider === "codex")).toMatchObject({ profile: "", count: 1 });
  });

  it("ranks providers by descending count", () => {
    const result = computeThroughputByProvider(
      [
        row({ issueId: "a", provider: "codex", claudeProfile: "" }),
        row({ issueId: "b", provider: "claude", claudeProfile: "anth" }),
        row({ issueId: "c", provider: "claude", claudeProfile: "anth" }),
      ],
      7,
    );
    expect(result.providers.map((p) => p.provider)).toEqual(["claude", "codex"]);
  });

  it("deduplicates by issue id — first row per issue wins", () => {
    const result = computeThroughputByProvider(
      [
        row({ issueId: "dup", provider: "claude", claudeProfile: "anth" }),
        row({ issueId: "dup", provider: "codex", claudeProfile: "" }),
      ],
      14,
    );
    expect(result.providers).toHaveLength(1);
    expect(result.providers[0]).toMatchObject({ provider: "claude", count: 1 });
  });

  it("skips rows without a merge or required timestamps", () => {
    const result = computeThroughputByProvider(
      [
        row({ issueId: "no-merge", mergedAt: null }),
        row({ issueId: "no-created", issueCreatedAt: null }),
        row({ issueId: "no-changed", statusChangedAt: null }),
        row({ issueId: "ok" }),
      ],
      14,
    );
    expect(result.providers).toHaveLength(1);
    expect(result.providers[0].count).toBe(1);
  });

  it("skips negative lead times (clock skew)", () => {
    const result = computeThroughputByProvider(
      [row({ issueId: "x", issueCreatedAt: "2026-01-05T00:00:00.000Z", statusChangedAt: "2026-01-01T00:00:00.000Z" })],
      14,
    );
    expect(result.providers).toHaveLength(0);
    expect(result.overallMedianLeadTimeMs).toBeNull();
  });

  it("computes median lead time per provider and overall", () => {
    const result = computeThroughputByProvider(
      [
        row({ issueId: "a", statusChangedAt: "2026-01-02T00:00:00.000Z" }), // 1d
        row({ issueId: "b", statusChangedAt: "2026-01-04T00:00:00.000Z" }), // 3d
      ],
      14,
    );
    expect(result.providers[0].medianLeadTimeMs).toBe(2 * DAY);
    expect(result.overallMedianLeadTimeMs).toBe(2 * DAY);
  });

  it("labels a null provider as unknown", () => {
    const result = computeThroughputByProvider([row({ provider: null, claudeProfile: "" })], 14);
    expect(result.providers[0].provider).toBe("unknown");
  });
});
