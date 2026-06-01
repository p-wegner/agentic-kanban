import { scheduledRunHistory, scheduledRuns } from "@agentic-kanban/shared/schema";
import { desc, eq } from "drizzle-orm";
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
  await database.delete(scheduledRunHistory).where(eq(scheduledRunHistory.scheduledRunId, id));
  await database.delete(scheduledRuns).where(eq(scheduledRuns.id, id));
}

export async function createScheduledRunHistory(
  input: {
    id: string;
    scheduledRunId: string;
    projectId: string;
    status: string;
    reason: string | null;
    triggeredBy: string;
    issueId: string | null;
    workspaceId: string | null;
    startedAt: string;
    completedAt: string | null;
  },
  database: Database = db,
) {
  const now = new Date().toISOString();
  await database.insert(scheduledRunHistory).values({
    ...input,
    createdAt: now,
  });
  return getScheduledRunHistoryById(input.id, database);
}

export async function updateScheduledRunHistory(
  id: string,
  updates: Record<string, unknown>,
  database: Database = db,
) {
  await database.update(scheduledRunHistory).set(updates).where(eq(scheduledRunHistory.id, id));
  return getScheduledRunHistoryById(id, database);
}

export async function getScheduledRunHistoryById(
  id: string,
  database: Database = db,
) {
  const rows = await database
    .select()
    .from(scheduledRunHistory)
    .where(eq(scheduledRunHistory.id, id))
    .limit(1);
  return rows[0] ?? null;
}

export async function getScheduledRunHistoryByProject(
  projectId: string,
  limit = 50,
  database: Database = db,
) {
  return database
    .select()
    .from(scheduledRunHistory)
    .where(eq(scheduledRunHistory.projectId, projectId))
    .orderBy(desc(scheduledRunHistory.startedAt))
    .limit(limit);
}
