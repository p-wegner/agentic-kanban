import { describe, expect, it } from "vitest";
import {
  formatCurrency,
  formatSuccessRate,
  formatTokens,
  formatDuration,
  formatCountdown,
  getAvgCost,
  getAvgTokens,
  getAvgTurns,
  sortMetricRows,
  utcDateKey,
  startOfUtcDay,
  addUtcDays,
  type MetricRowBase,
  type SortState,
} from "./insights-format.js";

function row(p: Partial<MetricRowBase>): MetricRowBase {
  return {
    sessionCount: 0, successCount: 0, totalCostUsd: 0, totalInputTokens: 0,
    totalOutputTokens: 0, totalTurns: 0, durationsMsP50: 0, durationsMsP95: 0, avgDurationMs: 0,
    ...p,
  };
}

describe("formatters", () => {
  it("formatCurrency uses 4 decimals", () => {
    expect(formatCurrency(1.5)).toBe("$1.5000");
  });
  it("formatSuccessRate guards divide-by-zero", () => {
    expect(formatSuccessRate(0, 0)).toBe("0%");
    expect(formatSuccessRate(1, 2)).toBe("50.0%");
  });
  it("formatTokens abbreviates K/M", () => {
    expect(formatTokens(500)).toBe("500");
    expect(formatTokens(1_500)).toBe("1.5K");
    expect(formatTokens(2_000_000)).toBe("2.0M");
  });
  it("formatDuration renders m/s from milliseconds", () => {
    expect(formatDuration(90_000)).toBe("1m 30s");
    expect(formatDuration(-5)).toBe("0m 0s");
  });
  it("formatCountdown buckets by magnitude", () => {
    expect(formatCountdown(null)).toBe("now");
    expect(formatCountdown(0)).toBe("now");
    expect(formatCountdown(30)).toBe("<1m");
    expect(formatCountdown(90)).toBe("1m");
    expect(formatCountdown(3 * 3600 + 5 * 60)).toBe("3h 5m");
    expect(formatCountdown(25 * 3600)).toBe("1d 1h");
  });
});

describe("per-session averages", () => {
  it("divide by sessionCount, guarding zero", () => {
    expect(getAvgCost(row({ sessionCount: 2, totalCostUsd: 1 }))).toBe(0.5);
    expect(getAvgTokens(row({ sessionCount: 2, totalInputTokens: 3, totalOutputTokens: 1 }))).toBe(2);
    expect(getAvgTurns(row({ sessionCount: 4, totalTurns: 8 }))).toBe(2);
    expect(getAvgCost(row({ sessionCount: 0, totalCostUsd: 5 }))).toBe(0);
  });
});

describe("sortMetricRows", () => {
  it("sorts numerically by key honoring direction", () => {
    const rows = [row({ sessionCount: 1 }), row({ sessionCount: 3 }), row({ sessionCount: 2 })];
    const sort: SortState = { key: "sessionCount", direction: "desc" };
    const out = sortMetricRows(rows, sort, () => "x");
    expect(out.map((r) => r.sessionCount)).toEqual([3, 2, 1]);
    const asc = sortMetricRows(rows, { key: "sessionCount", direction: "asc" }, () => "x");
    expect(asc.map((r) => r.sessionCount)).toEqual([1, 2, 3]);
  });
});

describe("utc date helpers", () => {
  it("utcDateKey / startOfUtcDay / addUtcDays", () => {
    const d = new Date("2026-06-20T15:30:00Z");
    expect(utcDateKey(d)).toBe("2026-06-20");
    expect(startOfUtcDay(d).toISOString()).toBe("2026-06-20T00:00:00.000Z");
    expect(utcDateKey(addUtcDays(d, 2))).toBe("2026-06-22");
  });
});
