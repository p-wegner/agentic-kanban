import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { milestones } from "@agentic-kanban/shared/schema";
import type { Database } from "../db/index.js";
import { firstRow } from "@agentic-kanban/shared/lib/first-row";

export async function listMilestonesByProject(projectId: string, database: Database) {
  return database.select().from(milestones).where(eq(milestones.projectId, projectId));
}

export async function getMilestoneById(id: string, database: Database) {
  return firstRow(database.select().from(milestones).where(eq(milestones.id, id)).limit(1));
}

export async function createMilestone(
  data: { projectId: string; name: string; dueDate?: string | null },
  database: Database,
) {
  const id = randomUUID();
  const now = new Date().toISOString();
  await database.insert(milestones).values({
    id,
    projectId: data.projectId,
    name: data.name,
    dueDate: data.dueDate ?? null,
    createdAt: now,
  });
  return { id, projectId: data.projectId, name: data.name, dueDate: data.dueDate ?? null, createdAt: now };
}

export async function updateMilestone(
  id: string,
  updates: { name?: string; dueDate?: string | null },
  database: Database,
) {
  const fields: Record<string, unknown> = {};
  if (updates.name !== undefined) fields.name = updates.name;
  if (updates.dueDate !== undefined) fields.dueDate = updates.dueDate;
  await database.update(milestones).set(fields).where(eq(milestones.id, id));
}

export async function deleteMilestone(id: string, database: Database) {
  await database.delete(milestones).where(eq(milestones.id, id));
}
