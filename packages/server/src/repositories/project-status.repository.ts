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
import { projectStatusIdName } from "./projections.js";
import { firstRow } from "@agentic-kanban/shared/lib/first-row";

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
  return firstRow(database.select().from(projectStatuses).where(eq(projectStatuses.id, statusId)).limit(1));
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

/**
 * The `{ id, name }` list for a project's statuses — declared ONCE (#732), and always
 * ORDERED by `sortOrder` (#773).
 *
 * Six repositories each carried a byte-identical copy of this query under six different
 * names: `getProjectStatusOptions` (merge-cleanup), `getProjectStatusIdsAndNames`
 * (project-service), `getProjectStatusList` (sprint-capacity),
 * `getProjectStatusNamesForVoiceCapture` (voice-capture) and `getProjectStatusRows` — the
 * same name, twice, in workspace-launch-failures and workspace-risk. Two more read it
 * inline. That is the "repeated accessor shape" #732 names, and the copies had already
 * DRIFTED: board-status's variant ordered by `sortOrder`, the other six returned whatever
 * SQLite handed back. #732 preserved that split behind an `opts.ordered` flag so the
 * consolidation stayed behaviour-preserving; #773 resolves it.
 *
 * ## Why there is no longer a flag
 *
 * "Unordered" is not a cheaper mode, it is an unspecified one. Measured on the real board DB
 * (29 projects, 7 statuses each), the unordered plan is
 * `SEARCH project_statuses USING INDEX project_statuses_project_name_unique (project_id=?)`
 * — so today it returns NAME order: `AI Reviewed, Backlog, Cancelled, Done, In Progress,
 * In Review, Todo`, whose first element is "AI Reviewed" and not the board's actual first
 * column "Backlog". That is #668's failure mode still latent in six call sites; it moves
 * again with any index/plan/VACUUM change.
 *
 * The cost of always ordering was measured before deciding, since there is no
 * `(project_id, sort_order)` index and the ordered plan adds `USE TEMP B-TREE FOR ORDER BY`:
 * over 4000 queries against the real DB, unordered ran 53-60 us and ordered 49-54 us — the
 * ORDER BY is inside the noise (and both runs happened to favour it) because the temp B-tree
 * sorts seven rows. So no index is needed and no caller pays for correctness; an
 * `{ ordered: false }` escape hatch would only be an invitation to reintroduce the bug.
 *
 * ## The eight callers, classified (#773)
 *
 * Order-DEPENDENT — would be silently wrong on an unordered read:
 * - `board-status.repository` -> the board's columns, rendered left-to-right to a human.
 * - `voice-capture.repository` -> `findTargetStatus` falls back to a SUBSTRING match
 *   (`"review"` matches both "In Review" and "AI Reviewed", first hit wins) and the
 *   not-found error renders the whole list to the user.
 *
 * Order-INDEPENDENT — each reduces the rows to a keyed lookup, and `project_statuses` has a
 * UNIQUE (project_id, name) index since 0125, so no `find`-by-name can be ambiguous:
 * - `issue.repository` (`initializeProjectStatuses`) -> Set of names + id-by-name record.
 * - `merge-cleanup.repository` -> `find` by exact name, and by status id.
 * - `project-service.repository` -> `filter(name === "Archived").map(id)`.
 * - `sprint-capacity.repository` -> `filter(name in BACKLOG_STATUS_NAMES).map(id)`.
 * - `workspace-launch-failures.repository` / `workspace-risk.repository` -> a Set of
 *   terminal ids + a `Map<id, name>`.
 *
 * They get ordered rows anyway, which is free and cannot hurt them. Each call site carries a
 * one-line note saying which group it is in, so the next reader does not re-derive this.
 *
 * The six original names are kept as one-line delegations at their old locations (the
 * `compat shim` kind — see packages/server/CLAUDE.md), so no service caller changes and the
 * query exists exactly once.
 */
export async function listProjectStatusIdNames(
  projectId: string,
  database: Database = db,
) {
  return database
    .select(projectStatusIdName)
    .from(projectStatuses)
    .where(eq(projectStatuses.projectId, projectId))
    .orderBy(projectStatuses.sortOrder);
}
