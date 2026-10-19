import { issues, projectStatuses } from "@agentic-kanban/shared/schema";
import { eq, and, inArray } from "drizzle-orm";
import { db } from "../db/index.js";
import type { Database, TransactionClient } from "../db/index.js";
import { firstRow } from "../lib/first-row.js";

/** A drizzle connection that is either the base db or an open transaction. */
type DbOrTx = Database | TransactionClient;

export async function getArchivedStatusId(
  projectId: string,
  database: DbOrTx = db,
): Promise<string | null> {
  const row = await firstRow(
    database
      .select({ id: projectStatuses.id })
      .from(projectStatuses)
      .where(and(eq(projectStatuses.projectId, projectId), eq(projectStatuses.name, "Archived")))
      .limit(1)
  );
  return row?.id ?? null;
}

export async function getDoneStatusIds(
  projectId: string,
  database: DbOrTx = db,
): Promise<string[]> {
  const rows = await database
    .select({ id: projectStatuses.id })
    .from(projectStatuses)
    .where(and(eq(projectStatuses.projectId, projectId), eq(projectStatuses.name, "Done")));
  return rows.map((s) => s.id);
}

export async function getDoneCandidateIssues(
  projectId: string,
  doneStatusIds: string[],
  database: DbOrTx = db,
) {
  return database
    .select({ id: issues.id, statusChangedAt: issues.statusChangedAt, createdAt: issues.createdAt })
    .from(issues)
    .where(and(eq(issues.projectId, projectId), inArray(issues.statusId, doneStatusIds)));
}

export async function archiveIssuesByIds(
  issueIds: string[],
  archivedStatusId: string,
  now: string,
  database: DbOrTx = db,
): Promise<void> {
  await database
    .update(issues)
    .set({ statusId: archivedStatusId, statusChangedAt: now, updatedAt: now })
    .where(inArray(issues.id, issueIds));
}
