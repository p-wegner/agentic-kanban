import { randomUUID } from "node:crypto";
import { issueTimeEntries } from "@agentic-kanban/shared/schema";
import { eq, sum } from "drizzle-orm";
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
