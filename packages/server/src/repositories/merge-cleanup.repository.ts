import { issues, projectStatuses } from "@agentic-kanban/shared/schema";
import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import type { Database } from "../db/index.js";

export async function getIssueStatusAndProject(issueId: string, database: Database = db) {
  const rows = await database
    .select({ statusId: issues.statusId, projectId: issues.projectId })
    .from(issues)
    .where(eq(issues.id, issueId))
    .limit(1);
  return rows[0] ?? null;
}

export async function getIssueProject(issueId: string, database: Database = db) {
  const rows = await database
    .select({ projectId: issues.projectId })
    .from(issues)
    .where(eq(issues.id, issueId))
    .limit(1);
  return rows[0] ?? null;
}

export async function getProjectStatusOptions(projectId: string, database: Database = db) {
  return database
    .select({ id: projectStatuses.id, name: projectStatuses.name })
    .from(projectStatuses)
    .where(eq(projectStatuses.projectId, projectId));
}

export async function setIssueStatus(
  issueId: string,
  statusId: string,
  now: string,
  database: Database = db,
): Promise<void> {
  await database
    .update(issues)
    .set({ statusId, updatedAt: now, statusChangedAt: now })
    .where(eq(issues.id, issueId));
}
