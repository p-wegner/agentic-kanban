import { eq, and, inArray, sql } from "drizzle-orm";
import { issues, issueDependencies, workspaces } from "@agentic-kanban/shared/schema";
import type { DependencyType } from "@agentic-kanban/shared/schema";
import { db } from "../db/index.js";
import type { Database } from "../db/index.js";
import { transitionIssueStatus } from "@agentic-kanban/shared/lib/workflow-engine";
import { firstRow } from "../lib/first-row.js";

export async function getIssueTitleDescription(
  issueId: string,
  database: Database = db,
) {
  return firstRow(
    database
      .select({ title: issues.title, description: issues.description })
      .from(issues)
      .where(eq(issues.id, issueId))
      .limit(1)
  );
}

/**
 * All `coupled_with` peer edges within a project, with both endpoints' issue numbers.
 * The contract step (#918) uses these to build connected coupled COMPONENTS — the
 * inverse view of the `parent_of`/`child_of` tree that `decomposeEpic` writes. Returns
 * only edges where both endpoints belong to `projectId`.
 */
export async function getCoupledEdges(
  projectId: string,
  database: Database = db,
): Promise<Array<{ issueId: string; dependsOnId: string }>> {
  const rows = await database
    .select({ issueId: issueDependencies.issueId, dependsOnId: issueDependencies.dependsOnId })
    .from(issueDependencies)
    .innerJoin(issues, eq(issueDependencies.issueId, issues.id))
    .where(and(eq(issueDependencies.type, "coupled_with"), eq(issues.projectId, projectId)));
  // Keep only edges whose OTHER endpoint is also in this project (defensive — edges are
  // never cross-project today, but the join above only constrains the `issueId` side).
  if (rows.length === 0) return [];
  const otherIds = [...new Set(rows.map((r) => r.dependsOnId))];
  const inProject = new Set(
    (await database.select({ id: issues.id }).from(issues)
      .where(and(eq(issues.projectId, projectId), inArray(issues.id, otherIds)))).map((r) => r.id),
  );
  return rows.filter((r) => inProject.has(r.dependsOnId));
}

/** Title/description/status/number for a set of issues — the contract proposal's source bodies. */
export async function getIssuesForContract(
  issueIds: string[],
  database: Database = db,
): Promise<Array<{ id: string; issueNumber: number; title: string; description: string | null; statusId: string; projectId: string }>> {
  if (issueIds.length === 0) return [];
  const rows = await database
    .select({ id: issues.id, issueNumber: issues.issueNumber, title: issues.title, description: issues.description, statusId: issues.statusId, projectId: issues.projectId })
    .from(issues)
    .where(inArray(issues.id, issueIds));
  // issue_number is nullable in the schema but backfilled for every real issue
  // (migration 0006); these are existing issues fetched by id, so it is non-null.
  return rows.map((r) => ({ ...r, issueNumber: r.issueNumber! }));
}

/** Whether any of `issueIds` has an OPEN (non-closed) workspace — a contract must not absorb in-flight work. */
export async function countOpenWorkspacesForIssues(
  issueIds: string[],
  database: Database = db,
): Promise<number> {
  if (issueIds.length === 0) return 0;
  const rows = await database
    .select({ id: workspaces.id })
    .from(workspaces)
    .where(and(inArray(workspaces.issueId, issueIds), sql`${workspaces.status} != 'closed'`));
  return rows.length;
}

/** Move an issue to a status and stamp updatedAt — used to Cancel members absorbed by a contract. */
export async function setIssueStatus(
  issueId: string,
  statusId: string,
  updatedAt: string,
  database: Database = db,
): Promise<void> {
  await transitionIssueStatus(database, issueId, statusId, { now: updatedAt });
}

/** Append text to an issue's description (e.g. the absorbed-into pointer). */
export async function appendIssueDescription(
  issueId: string,
  suffix: string,
  updatedAt: string,
  database: Database = db,
): Promise<void> {
  const existing = await getIssueTitleDescription(issueId, database);
  const next = existing?.description ? `${existing.description}\n\n${suffix}` : suffix;
  await database.update(issues).set({ description: next, updatedAt }).where(eq(issues.id, issueId));
}

/** Set both title and description (the contract survivor takes the merged body). */
export async function updateIssueTitleDescription(
  issueId: string,
  title: string,
  description: string,
  updatedAt: string,
  database: Database = db,
): Promise<void> {
  await database.update(issues).set({ title, description, updatedAt }).where(eq(issues.id, issueId));
}

/** All dependency edges in a project (any type), as `{ from, to, type }` for the contraction planner. */
export async function getProjectDependencyEdges(
  projectId: string,
  database: Database = db,
): Promise<Array<{ from: string; to: string; type: DependencyType }>> {
  const rows = await database
    .select({ from: issueDependencies.issueId, to: issueDependencies.dependsOnId, type: issueDependencies.type })
    .from(issueDependencies)
    .innerJoin(issues, eq(issueDependencies.issueId, issues.id))
    .where(eq(issues.projectId, projectId));
  return rows as Array<{ from: string; to: string; type: DependencyType }>;
}

/** Remove a specific dependency edge by its (issueId, dependsOnId, type) triple. */
export async function removeDependencyEdge(
  issueId: string,
  dependsOnId: string,
  type: DependencyType,
  database: Database = db,
): Promise<void> {
  await database.delete(issueDependencies).where(
    and(
      eq(issueDependencies.issueId, issueId),
      eq(issueDependencies.dependsOnId, dependsOnId),
      eq(issueDependencies.type, type),
    ),
  );
}
