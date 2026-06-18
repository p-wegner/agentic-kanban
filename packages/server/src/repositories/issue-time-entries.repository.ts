import { randomUUID } from "node:crypto";
import { issueTimeEntries, issues } from "@agentic-kanban/shared/schema";
import { eq, sum, and, gte, lte, sql } from "drizzle-orm";
import { db } from "../db/index.js";
import type { Database } from "../db/index.js";

export interface AddTimeEntryInput {
  issueId: string;
  minutes: number;
  note?: string | null;
  now?: string;
}

export type TimeEntryRow = typeof issueTimeEntries.$inferSelect;

export async function insertTimeEntry(
  input: AddTimeEntryInput,
  database: Database = db,
): Promise<TimeEntryRow> {
  const id = randomUUID();
  const createdAt = input.now ?? new Date().toISOString();
  const row = {
    id,
    issueId: input.issueId,
    minutes: input.minutes,
    note: input.note ?? null,
    createdAt,
  };
  await database.insert(issueTimeEntries).values(row);
  return row;
}

export async function getTimeEntries(
  issueId: string,
  database: Database = db,
): Promise<TimeEntryRow[]> {
  return database
    .select()
    .from(issueTimeEntries)
    .where(eq(issueTimeEntries.issueId, issueId))
    .orderBy(issueTimeEntries.createdAt);
}

export async function getTotalMinutes(
  issueId: string,
  database: Database = db,
): Promise<number> {
  const result = await database
    .select({ total: sum(issueTimeEntries.minutes) })
    .from(issueTimeEntries)
    .where(eq(issueTimeEntries.issueId, issueId));
  return Number(result[0]?.total ?? 0);
}

export async function deleteTimeEntry(
  entryId: string,
  database: Database = db,
): Promise<void> {
  await database.delete(issueTimeEntries).where(eq(issueTimeEntries.id, entryId));
}

/** Shared filter for the project time report: project scope + an optional createdAt window. */
function timeReportWhere(projectId: string, dateFrom: string | null, dateTo: string) {
  return dateFrom
    ? and(
        eq(issues.projectId, projectId),
        gte(issueTimeEntries.createdAt, dateFrom),
        lte(issueTimeEntries.createdAt, dateTo),
      )
    : and(eq(issues.projectId, projectId), lte(issueTimeEntries.createdAt, dateTo));
}

/** Minutes logged per issue within the window, most-time-first. */
export async function getTimeReportByIssue(
  projectId: string,
  dateFrom: string | null,
  dateTo: string,
  database: Database = db,
) {
  return database
    .select({
      issueId: issues.id,
      issueNumber: issues.issueNumber,
      issueTitle: issues.title,
      totalMinutes: sum(issueTimeEntries.minutes),
    })
    .from(issueTimeEntries)
    .innerJoin(issues, eq(issueTimeEntries.issueId, issues.id))
    .where(timeReportWhere(projectId, dateFrom, dateTo))
    .groupBy(issues.id, issues.issueNumber, issues.title)
    .orderBy(sql`sum(${issueTimeEntries.minutes}) desc`);
}

/** Minutes logged per calendar day (YYYY-MM-DD) within the window, ascending. */
export async function getTimeReportByDay(
  projectId: string,
  dateFrom: string | null,
  dateTo: string,
  database: Database = db,
) {
  return database
    .select({
      date: sql<string>`substr(${issueTimeEntries.createdAt}, 1, 10)`,
      totalMinutes: sum(issueTimeEntries.minutes),
    })
    .from(issueTimeEntries)
    .innerJoin(issues, eq(issueTimeEntries.issueId, issues.id))
    .where(timeReportWhere(projectId, dateFrom, dateTo))
    .groupBy(sql`substr(${issueTimeEntries.createdAt}, 1, 10)`)
    .orderBy(sql`substr(${issueTimeEntries.createdAt}, 1, 10)`);
}
