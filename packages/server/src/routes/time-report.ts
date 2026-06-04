import { and, eq, gte, lte, sql, sum } from "drizzle-orm";
import { issueTimeEntries, issues } from "@agentic-kanban/shared/schema";
import { db } from "../db/index.js";
import type { Database } from "../db/index.js";
import { createRouter } from "../middleware/create-router.js";

const RANGE_DAYS = {
  "7d": 7,
  "30d": 30,
  "90d": 90,
} as const;

type TimeReportRange = keyof typeof RANGE_DAYS | "all";

function parseRange(value: string | undefined): TimeReportRange {
  if (value === "7d" || value === "30d" || value === "90d" || value === "all") {
    return value;
  }
  return "30d";
}

export interface TimeReportByIssue {
  issueId: string;
  issueNumber: number | null;
  issueTitle: string;
  totalMinutes: number;
}

export interface TimeReportByDay {
  date: string;
  totalMinutes: number;
}

export interface TimeReportData {
  byIssue: TimeReportByIssue[];
  byDay: TimeReportByDay[];
  totalMinutes: number;
  dateFrom: string;
  dateTo: string;
}

export function createTimeReportRoute(database: Database = db) {
  const router = createRouter();

  // GET /api/projects/:id/time-report?range=30d
  router.get("/:id/time-report", async (c) => {
    const projectId = c.req.param("id");
    const range = parseRange(c.req.query("range"));

    const now = new Date();
    const dateTo = now.toISOString();
    const dateFrom = range === "all"
      ? null
      : new Date(now.getTime() - RANGE_DAYS[range] * 24 * 60 * 60 * 1000).toISOString();

    const whereClause = dateFrom
      ? and(
          eq(issues.projectId, projectId),
          gte(issueTimeEntries.createdAt, dateFrom),
          lte(issueTimeEntries.createdAt, dateTo),
        )
      : and(
          eq(issues.projectId, projectId),
          lte(issueTimeEntries.createdAt, dateTo),
        );

    // Single grouped query: join entries with issues, group by issueId
    const byIssueRows = await database
      .select({
        issueId: issues.id,
        issueNumber: issues.issueNumber,
        issueTitle: issues.title,
        totalMinutes: sum(issueTimeEntries.minutes),
      })
      .from(issueTimeEntries)
      .innerJoin(issues, eq(issueTimeEntries.issueId, issues.id))
      .where(whereClause)
      .groupBy(issues.id, issues.issueNumber, issues.title)
      .orderBy(sql`sum(${issueTimeEntries.minutes}) desc`);

    // Single grouped query: group by date (first 10 chars of ISO string)
    const byDayRows = await database
      .select({
        date: sql<string>`substr(${issueTimeEntries.createdAt}, 1, 10)`,
        totalMinutes: sum(issueTimeEntries.minutes),
      })
      .from(issueTimeEntries)
      .innerJoin(issues, eq(issueTimeEntries.issueId, issues.id))
      .where(whereClause)
      .groupBy(sql`substr(${issueTimeEntries.createdAt}, 1, 10)`)
      .orderBy(sql`substr(${issueTimeEntries.createdAt}, 1, 10)`);

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

    // Fill missing days in range with 0
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

    const response: TimeReportData = {
      byIssue,
      byDay: filledByDay,
      totalMinutes,
      dateFrom: dateFrom ?? (byDay[0]?.date ? byDay[0].date + "T00:00:00.000Z" : dateTo),
      dateTo,
    };

    return c.json(response);
  });

  return router;
}
