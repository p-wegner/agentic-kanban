import type { TimeReportByDay, TimeReportByIssue, TimeReportData } from "@agentic-kanban/shared";
// #704: moved to shared/src/types/api/. Re-exported so importers of this module are unchanged.
export type { TimeReportByDay, TimeReportByIssue, TimeReportData };
/**
 * Time-report aggregation (#606).
 *
 * This was inline in `routes/time-report.ts` — one of the five routes that aggregate over
 * repositories instead of going through a service, while `packages/server/CLAUDE.md` says
 * the adapter stays thin.
 *
 * The extraction also makes it testable: the route called `new Date()` in its handler, so
 * the gap-filling logic (the part with real edge cases) could only be exercised against
 * whatever today happens to be. `now` is injected per the #614 rule — `now?: string`,
 * ISO, because the value is both compared and returned in the payload.
 */
import type { Database } from "../db/index.js";
import { getTimeReportByIssue, getTimeReportByDay } from "../repositories/issue-time-entries.repository.js";

const RANGE_DAYS = {
  "7d": 7,
  "30d": 30,
  "90d": 90,
} as const;

export type TimeReportRange = keyof typeof RANGE_DAYS | "all";

/** Unknown/absent range falls back to 30d — the historical default. */
export function parseRange(value: string | undefined): TimeReportRange {
  if (value === "7d" || value === "30d" || value === "90d" || value === "all") {
    return value;
  }
  return "30d";
}







export async function computeTimeReport(
  projectId: string,
  range: TimeReportRange,
  database: Database,
  now?: string,
): Promise<TimeReportData> {
  const nowDate = now ? new Date(now) : new Date();
  const dateTo = nowDate.toISOString();
  const dateFrom = range === "all"
    ? null
    : new Date(nowDate.getTime() - RANGE_DAYS[range] * 24 * 60 * 60 * 1000).toISOString();

  const byIssueRows = await getTimeReportByIssue(projectId, dateFrom, dateTo, database);
  const byDayRows = await getTimeReportByDay(projectId, dateFrom, dateTo, database);

  const byIssue: TimeReportByIssue[] = byIssueRows.map((row) => ({
    issueId: row.issueId,
    issueNumber: row.issueNumber,
    issueTitle: row.issueTitle,
    totalMinutes: Number(row.totalMinutes ?? 0),
  }));

  const byDay: TimeReportByDay[] = byDayRows.map((row) => ({
    date: row.date,
    totalMinutes: Number(row.totalMinutes ?? 0),
  }));

  const totalMinutes = byIssue.reduce((acc, r) => acc + r.totalMinutes, 0);

  // Fill missing days so a chart has a continuous x-axis rather than gaps.
  const filledByDay: TimeReportByDay[] = [];
  if (byDay.length > 0 || dateFrom) {
    const startStr = dateFrom ? dateFrom.slice(0, 10) : (byDay[0]?.date ?? dateTo.slice(0, 10));
    const endStr = dateTo.slice(0, 10);
    const dayMap = new Map(byDay.map((d) => [d.date, d.totalMinutes]));
    const cursor = new Date(startStr + "T00:00:00Z");
    const end = new Date(endStr + "T00:00:00Z");
    while (cursor <= end) {
      const key = cursor.toISOString().slice(0, 10);
      filledByDay.push({ date: key, totalMinutes: dayMap.get(key) ?? 0 });
      cursor.setUTCDate(cursor.getUTCDate() + 1);
    }
  }

  return {
    byIssue,
    byDay: filledByDay,
    totalMinutes,
    dateFrom: dateFrom ?? (byDay[0]?.date ? byDay[0].date + "T00:00:00.000Z" : dateTo),
    dateTo,
  };
}
