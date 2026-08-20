import { describe, expect, it, vi, beforeEach } from "vitest";
import type { Database } from "../db/index.js";

/**
 * The gap-filling and range arithmetic used to live in `routes/time-report.ts` and called
 * `new Date()` inside the handler, so it could only ever run against whatever today
 * happened to be (#606/#614). With the logic in a service and `now` injected, the day
 * series — the part with the real edge cases — is an ordinary unit test.
 *
 * The two repository functions are mocked: what is under test is the PROJECTION (day
 * series, totals, boundary dates), not the SQL.
 */
const getTimeReportByIssue = vi.fn();
const getTimeReportByDay = vi.fn();

vi.mock("../repositories/issue-time-entries.repository.js", () => ({
  getTimeReportByIssue: (...args: unknown[]) => getTimeReportByIssue(...args),
  getTimeReportByDay: (...args: unknown[]) => getTimeReportByDay(...args),
}));

const { computeTimeReport, parseRange } = await import("../services/time-report.service.js");
const db = {} as Database;
const NOW = "2026-03-10T12:00:00.000Z";

beforeEach(() => {
  getTimeReportByIssue.mockReset().mockResolvedValue([]);
  getTimeReportByDay.mockReset().mockResolvedValue([]);
});

describe("parseRange (#606)", () => {
  it("accepts the four known ranges", () => {
    expect(["7d", "30d", "90d", "all"].map((r) => parseRange(r))).toEqual(["7d", "30d", "90d", "all"]);
  });

  it("falls back to 30d for anything else — the historical default", () => {
    expect(parseRange(undefined)).toBe("30d");
    expect(parseRange("")).toBe("30d");
    expect(parseRange("7")).toBe("30d");
  });
});

describe("computeTimeReport (#606)", () => {
  it("emits one entry per day across the window, inclusive of both ends", async () => {
    const report = await computeTimeReport("p1", "7d", db, NOW);
    // 7d back from Mar 10 is Mar 3; Mar 3..Mar 10 inclusive is 8 days.
    expect(report.byDay).toHaveLength(8);
    expect(report.byDay[0].date).toBe("2026-03-03");
    expect(report.byDay.at(-1)?.date).toBe("2026-03-10");
  });

  it("fills days the query returned nothing for with 0, keeping the ones it did", async () => {
    getTimeReportByDay.mockResolvedValue([
      { date: "2026-03-05", totalMinutes: 45 },
      { date: "2026-03-08", totalMinutes: 15 },
    ]);
    const report = await computeTimeReport("p1", "7d", db, NOW);
    const byDate = Object.fromEntries(report.byDay.map((d) => [d.date, d.totalMinutes]));
    expect(byDate["2026-03-05"]).toBe(45);
    expect(byDate["2026-03-08"]).toBe(15);
    expect(byDate["2026-03-06"]).toBe(0);
    expect(byDate["2026-03-04"]).toBe(0);
  });

  it("totals minutes from the per-issue rows, coercing null to 0", async () => {
    getTimeReportByIssue.mockResolvedValue([
      { issueId: "a", issueNumber: 1, issueTitle: "A", totalMinutes: 30 },
      { issueId: "b", issueNumber: 2, issueTitle: "B", totalMinutes: null },
      { issueId: "c", issueNumber: null, issueTitle: "C", totalMinutes: "12" },
    ]);
    const report = await computeTimeReport("p1", "30d", db, NOW);
    expect(report.totalMinutes).toBe(42);
    expect(report.byIssue.map((i) => i.totalMinutes)).toEqual([30, 0, 12]);
  });

  it("range 'all' passes a null lower bound to the repositories", async () => {
    await computeTimeReport("p1", "all", db, NOW);
    expect(getTimeReportByIssue).toHaveBeenCalledWith("p1", null, NOW, db);
    expect(getTimeReportByDay).toHaveBeenCalledWith("p1", null, NOW, db);
  });

  it("a bounded range passes the computed lower bound", async () => {
    await computeTimeReport("p1", "30d", db, NOW);
    const [, from] = getTimeReportByIssue.mock.calls[0] as [string, string];
    expect(from.slice(0, 10)).toBe("2026-02-08"); // 30 days before Mar 10
  });

  it("with range 'all' and no rows, dateFrom degrades to dateTo rather than undefined", async () => {
    const report = await computeTimeReport("p1", "all", db, NOW);
    expect(report.dateFrom).toBe(NOW);
    expect(report.dateTo).toBe(NOW);
    expect(report.byDay).toEqual([]);
  });
});
