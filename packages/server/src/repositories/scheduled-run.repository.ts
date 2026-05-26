import { scheduledRuns } from "@agentic-kanban/shared/schema";
import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import type { Database } from "../db/index.js";

export async function getScheduledRunsByProject(
  projectId: string,
  database: Database = db,
) {
  return database
    .select()
    .from(scheduledRuns)
    .where(eq(scheduledRuns.projectId, projectId));
}

export async function getScheduledRunById(
  id: string,
  database: Database = db,
) {
  const rows = await database
    .select()
    .from(scheduledRuns)
    .where(eq(scheduledRuns.id, id))
    .limit(1);
  return rows[0] ?? null;
}

export async function createScheduledRun(
  input: {
    id: string;
    name: string;
    description: string | null;
    projectId: string;
    prompt: string | null;
    skillId: string | null;
    intervalMinutes: number;
    cronExpression: string | null;
    enabled: boolean;
    systemIssueId: string | null;
  },
  database: Database = db,
) {
  const now = new Date().toISOString();
  await database.insert(scheduledRuns).values({
    id: input.id,
    name: input.name,
    description: input.description,
    projectId: input.projectId,
    prompt: input.prompt,
    skillId: input.skillId,
    intervalMinutes: input.intervalMinutes,
    cronExpression: input.cronExpression,
    enabled: input.enabled,
    systemIssueId: input.systemIssueId,
    createdAt: now,
    updatedAt: now,
  });
  return getScheduledRunById(input.id, database);
}

export async function updateScheduledRun(
  id: string,
  updates: Record<string, unknown>,
  database: Database = db,
) {
  await database.update(scheduledRuns).set(updates).where(eq(scheduledRuns.id, id));
  return getScheduledRunById(id, database);
}

export async function deleteScheduledRun(
  id: string,
  database: Database = db,
) {
  await database.delete(scheduledRuns).where(eq(scheduledRuns.id, id));
}
