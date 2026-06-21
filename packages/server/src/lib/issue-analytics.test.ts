import { describe, it, expect } from "vitest";
import {
  clampDays,
  buildDateAxis,
  cutoffDayFor,
  computeBurndown,
  computeCfd,
  computeThroughput,
  computeLeadTime,
  type StatusTimelineRow,
  type DoneIssueRow,
} from "./issue-analytics.js";

// All timestamps are pinned to noon UTC so toISOString()-derived day strings are
// stable regardless of the test runner's local timezone (the axis is built with
// local setDate() but formatted as UTC; a ±12h offset at noon never flips the day).
const NOW = new Date("2026-06-21T12:00:00.000Z");
const at = (day: string) => `${day}T12:00:00.000Z`;

const DAY_MS = 24 * 60 * 60 * 1000;

describe("clampDays", () => {
  it("falls back when the param is missing", () => {
    expect(clampDays(undefined, 30)).toBe(30);
    expect(clampDays(undefined, 14)).toBe(14);
  });
  it("parses a valid integer", () => {
    expect(clampDays("14", 30)).toBe(14);
  });
  it("falls back on a non-numeric param", () => {
    expect(clampDays("abc", 30)).toBe(30);
  });
  it("clamps to [1, 365]", () => {
    expect(clampDays("0", 30)).toBe(1);
    expect(clampDays("-5", 14)).toBe(1);
    expect(clampDays("9999", 30)).toBe(365);
  });
});

describe("buildDateAxis", () => {
  it("is inclusive of both endpoints, one entry per day", () => {
    expect(buildDateAxis(new Date(at("2026-06-19")), new Date(at("2026-06-21")))).toEqual([
      "2026-06-19",
      "2026-06-20",
      "2026-06-21",
    ]);
  });
  it("is a single day when start === end", () => {
    expect(buildDateAxis(new Date(at("2026-06-21")), new Date(at("2026-06-21")))).toEqual([
      "2026-06-21",
    ]);
  });
  it("is empty when start is after end", () => {
    expect(buildDateAxis(new Date(at("2026-06-22")), new Date(at("2026-06-21")))).toEqual([]);
  });
});

describe("cutoffDayFor", () => {
  it("is days-1 calendar days before now", () => {
    expect(cutoffDayFor(NOW, 7)).toBe("2026-06-15");
    expect(cutoffDayFor(NOW, 1)).toBe("2026-06-21");
  });
});

describe("computeBurndown", () => {
  const rows: StatusTimelineRow[] = [
    // Opened before the window, still open today.
    { createdAt: at("2026-06-10"), statusChangedAt: at("2026-06-12"), statusName: "In Progress", statusSortOrder: 1 },
    // Opened in-window, closed in-window.
    { createdAt: at("2026-06-16"), statusChangedAt: at("2026-06-18"), statusName: "Done", statusSortOrder: 3 },
    // Created straight into a terminal status (never open): opened & closed same day.
    { createdAt: at("2026-06-19"), statusChangedAt: null, statusName: "Done", statusSortOrder: 3 },
  ];

  it("produces one bucket per day of the window", () => {
    const result = computeBurndown(rows, 7, NOW);
    expect(result.buckets.map((b) => b.date)).toEqual([
      "2026-06-15", "2026-06-16", "2026-06-17", "2026-06-18", "2026-06-19", "2026-06-20", "2026-06-21",
    ]);
  });

  it("tracks remaining-open, opened, and closed per day", () => {
    const { buckets } = computeBurndown(rows, 7, NOW);
    const byDate = Object.fromEntries(buckets.map((b) => [b.date, b]));
    expect(byDate["2026-06-15"]).toMatchObject({ remaining: 1, opened: 0, closed: 0 });
    expect(byDate["2026-06-16"]).toMatchObject({ remaining: 2, opened: 1, closed: 0 });
    expect(byDate["2026-06-18"]).toMatchObject({ remaining: 1, opened: 0, closed: 1 });
    expect(byDate["2026-06-19"]).toMatchObject({ remaining: 1, opened: 1, closed: 1 });
    expect(byDate["2026-06-21"]).toMatchObject({ remaining: 1, opened: 0, closed: 0 });
  });

  it("summarizes start/end counts and totals", () => {
    const r = computeBurndown(rows, 7, NOW);
    expect(r.startCount).toBe(1);
    expect(r.endCount).toBe(1);
    expect(r.totalOpened).toBe(2);
    expect(r.totalClosed).toBe(2);
  });

  it("returns zeroed summary on an empty board", () => {
    const r = computeBurndown([], 5, NOW);
    expect(r.buckets.every((b) => b.remaining === 0 && b.opened === 0 && b.closed === 0)).toBe(true);
    expect(r).toMatchObject({ startCount: 0, endCount: 0, totalOpened: 0, totalClosed: 0 });
  });
});

describe("computeCfd", () => {
  const rows: StatusTimelineRow[] = [
    { createdAt: at("2026-06-10"), statusChangedAt: at("2026-06-19"), statusName: "Done", statusSortOrder: 2 },
    { createdAt: at("2026-06-20"), statusChangedAt: null, statusName: "Todo", statusSortOrder: 0 },
    { createdAt: at("2026-06-05"), statusChangedAt: at("2026-06-18"), statusName: "In Progress", statusSortOrder: 1 },
  ];

  it("orders statuses by board sort order", () => {
    expect(computeCfd(rows, 3, NOW).statuses).toEqual(["Todo", "In Progress", "Done"]);
  });

  it("spans days+1 entries (start = now - days)", () => {
    const dates = [...new Set(computeCfd(rows, 3, NOW).counts.map((c) => c.date))];
    expect(dates).toEqual(["2026-06-18", "2026-06-19", "2026-06-20", "2026-06-21"]);
  });

  it("counts issues cumulatively from the day they entered their status", () => {
    const { counts } = computeCfd(rows, 3, NOW);
    const get = (date: string, status: string) =>
      counts.find((c) => c.date === date && c.status === status)?.count;
    // entered: In Progress on 06-18, Done on 06-19, Todo on 06-20.
    expect(get("2026-06-18", "In Progress")).toBe(1);
    expect(get("2026-06-18", "Done")).toBe(0);
    expect(get("2026-06-19", "Done")).toBe(1);
    expect(get("2026-06-20", "Todo")).toBe(1);
    expect(get("2026-06-21", "In Progress")).toBe(1);
  });
});

describe("computeThroughput", () => {
  const rows: DoneIssueRow[] = [
    { createdAt: at("2026-06-10"), statusChangedAt: at("2026-06-19") },
    { createdAt: at("2026-06-11"), statusChangedAt: at("2026-06-19") },
    { createdAt: at("2026-06-01"), statusChangedAt: at("2026-06-21") },
    { createdAt: at("2026-06-09"), statusChangedAt: null }, // never moved -> ignored
  ];

  it("zero-fills every day and counts moves-to-Done per day", () => {
    const { points } = computeThroughput(rows, 4, NOW);
    expect(points).toEqual([
      { date: "2026-06-18", count: 0 },
      { date: "2026-06-19", count: 2 },
      { date: "2026-06-20", count: 0 },
      { date: "2026-06-21", count: 1 },
    ]);
  });
});

describe("computeLeadTime", () => {
  const rows: DoneIssueRow[] = [
    { statusChangedAt: at("2026-06-19"), createdAt: at("2026-06-17") }, // 2d
    { statusChangedAt: at("2026-06-19"), createdAt: at("2026-06-15") }, // 4d
    { statusChangedAt: at("2026-06-19"), createdAt: at("2026-06-13") }, // 6d
    { statusChangedAt: at("2026-06-20"), createdAt: at("2026-06-21") }, // negative -> filtered
  ];

  it("computes median (p50) and p90 with linear interpolation", () => {
    const { buckets } = computeLeadTime(rows, 4, NOW);
    const byDate = Object.fromEntries(buckets.map((b) => [b.date, b]));
    expect(byDate["2026-06-19"]).toMatchObject({ count: 3, medianMs: 4 * DAY_MS });
    // p90 over [2d,4d,6d]: idx 1.8 -> 4d + (6d-4d)*0.8 = 5.6 days.
    expect(byDate["2026-06-19"].p90Ms).toBeCloseTo(5.6 * DAY_MS, 0);
  });

  it("reports null for days with no completions and filters negative lead times", () => {
    const { buckets } = computeLeadTime(rows, 4, NOW);
    const byDate = Object.fromEntries(buckets.map((b) => [b.date, b]));
    expect(byDate["2026-06-20"]).toMatchObject({ count: 0, medianMs: null, p90Ms: null });
    expect(byDate["2026-06-18"]).toMatchObject({ count: 0, medianMs: null, p90Ms: null });
  });
});
