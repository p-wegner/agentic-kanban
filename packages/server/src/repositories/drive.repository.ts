import { eq, desc } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { drives } from "@agentic-kanban/shared/schema";
import type { DriveStatus } from "@agentic-kanban/shared/schema";
import type { Database } from "../db/index.js";
import { db } from "../db/index.js";

export type DriveRow = typeof drives.$inferSelect;

export async function listDrivesByProject(projectId: string, database: Database) {
  return database
    .select()
    .from(drives)
    .where(eq(drives.projectId, projectId))
    .orderBy(desc(drives.startedAt));
}

export async function getDriveById(id: string, database: Database = db) {
  const rows = await database.select().from(drives).where(eq(drives.id, id)).limit(1);
  return rows[0] ?? null;
}

export async function createDrive(
  data: {
    projectId: string;
    metaIssueId?: string | null;
    target: string;
    completionContract?: string | null;
    status?: DriveStatus;
    startedAt?: string;
  },
  database: Database,
): Promise<DriveRow> {
  const id = randomUUID();
  const startedAt = data.startedAt ?? new Date().toISOString();
  const row = {
    id,
    projectId: data.projectId,
    metaIssueId: data.metaIssueId ?? null,
    target: data.target,
    completionContract: data.completionContract ?? null,
    status: data.status ?? ("active"),
    startedAt,
    finishedAt: null,
  };
  await database.insert(drives).values(row);
  return row;
}

export async function updateDrive(
  id: string,
  updates: {
    metaIssueId?: string | null;
    target?: string;
    completionContract?: string | null;
    status?: DriveStatus;
    finishedAt?: string | null;
  },
  database: Database,
) {
  const fields: Record<string, unknown> = {};
  if (updates.metaIssueId !== undefined) fields.metaIssueId = updates.metaIssueId;
  if (updates.target !== undefined) fields.target = updates.target;
  if (updates.completionContract !== undefined) fields.completionContract = updates.completionContract;
  if (updates.status !== undefined) fields.status = updates.status;
  if (updates.finishedAt !== undefined) fields.finishedAt = updates.finishedAt;
  if (Object.keys(fields).length > 0) {
    await database.update(drives).set(fields).where(eq(drives.id, id));
  }
}

export async function deleteDrive(id: string, database: Database) {
  await database.delete(drives).where(eq(drives.id, id));
}
