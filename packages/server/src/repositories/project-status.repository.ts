/**
 * Project-status (kanban column) persistence — split out of `project.repository.ts` so that
 * file stays under the god-module cohesion ceiling (20 top-level declarations, #889/#977).
 *
 * These six functions form one responsibility: the lifecycle of a project's `project_statuses`
 * rows (list, create, reorder, delete). They are re-exported from `project.repository.ts` as a
 * facade barrel, so every existing importer keeps working and no consumer needs to know the
 * file was split.
 *
 * `project_statuses` has no owner entry in `repository-table-ownership` (#957) — only `projects`
 * and `sessions` are owned — so holding its queries here is not ownership drift. The one
 * cross-table read below (`issues`, to refuse deleting a status that still has issues on it) is
 * a guard read that belongs with the delete it protects.
 */
import { projectStatuses, issues } from "@agentic-kanban/shared/schema";
import { eq, and, inArray } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { db } from "../db/index.js";
import type { Database } from "../db/index.js";

export async function getProjectStatuses(
  projectId: string,
  database: Database = db,
) {
  return database
    .select()
    .from(projectStatuses)
    .where(eq(projectStatuses.projectId, projectId))
    .orderBy(projectStatuses.sortOrder);
}

export async function createProjectStatus(
  projectId: string,
  name: string,
  sortOrder: number,
  database: Database = db,
) {
  const id = randomUUID();
  const now = new Date().toISOString();
  await database.insert(projectStatuses).values({
    id,
    projectId,
    name,
    sortOrder,
    createdAt: now,
  });
  return { id, projectId, name };
}

export async function updateProjectStatusSortOrder(
  projectId: string,
  statusId: string,
  sortOrder: number,
  database: Database = db,
): Promise<{ success: true } | { error: string; status: number }> {
  const rows = await database
    .select()
    .from(projectStatuses)
    .where(and(eq(projectStatuses.id, statusId), eq(projectStatuses.projectId, projectId)));

  if (rows.length === 0) {
    return { error: "Status not found", status: 404 };
  }

  await database
    .update(projectStatuses)
    .set({ sortOrder })
    .where(and(eq(projectStatuses.id, statusId), eq(projectStatuses.projectId, projectId)));

  return { success: true };
}

export async function deleteProjectStatus(
  projectId: string,
  statusId: string,
  database: Database = db,
): Promise<{ success: true } | { error: string; status: number }> {
  const statusRows = await database
    .select()
    .from(projectStatuses)
    .where(and(eq(projectStatuses.id, statusId), eq(projectStatuses.projectId, projectId)));

  if (statusRows.length === 0) {
    return { error: "Status not found", status: 404 };
  }

  const linkedIssues = await database
    .select({ id: issues.id })
    .from(issues)
    .where(eq(issues.statusId, statusId))
    .limit(1);

  if (linkedIssues.length > 0) {
    return { error: "Cannot delete status with linked issues", status: 409 };
  }

  await database.delete(projectStatuses).where(eq(projectStatuses.id, statusId));
  return { success: true };
}

/** A single project status by its id (no project scoping), or null. */
export async function getProjectStatusById(statusId: string, database: Database = db) {
  const rows = await database.select().from(projectStatuses).where(eq(projectStatuses.id, statusId)).limit(1);
  return rows[0] ?? null;
}

/** Delete a project status by id alone (caller has already validated). */
export async function deleteProjectStatusById(statusId: string, database: Database = db): Promise<void> {
  await database.delete(projectStatuses).where(eq(projectStatuses.id, statusId));
}

/**
 * Status ids for the given column NAMES within one project (#502).
 *
 * `getTerminalStatusIds` was declared three times. Two of those — `issue-ai.repository`
 * and `ticket-preflight.repository` — were the same query with the same signature and
 * different parameter names; they call this now.
 *
 * The third, in `foundational-merge.repository`, is deliberately NOT folded in: it takes
 * no projectId and hardcodes ('Done','Cancelled'), i.e. it collects terminal status ids
 * across EVERY project. That is correct for its caller, which only tests membership of a
 * status id (ids are unique rows, so a wider set cannot produce a false positive), and
 * narrowing it to one project would need a projectId its caller does not have.
 */
export async function getStatusIdsByName(
  projectId: string,
  statusNames: string[],
  database: Database = db,
): Promise<string[]> {
  const rows = await database
    .select({ id: projectStatuses.id })
    .from(projectStatuses)
    .where(and(eq(projectStatuses.projectId, projectId), inArray(projectStatuses.name, statusNames)));
  return rows.map((r) => r.id);
}
