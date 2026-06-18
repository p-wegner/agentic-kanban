import { issueDependencies, issues, projectStatuses } from "@agentic-kanban/shared/schema";
import { inArray, sql } from "drizzle-orm";
import { db } from "../db/index.js";
import type { Database } from "../db/index.js";

/** Ids of the terminal (Done/Cancelled) project statuses. */
export async function getTerminalStatusIds(database: Database = db): Promise<Set<string>> {
  const rows = await database
    .select({ id: projectStatuses.id })
    .from(projectStatuses)
    .where(sql`${projectStatuses.name} IN ('Done', 'Cancelled')`);
  return new Set(rows.map((r) => r.id));
}

/** Blocking dependency edges (depends_on/blocked_by) of `issueId`. */
export async function getBlockingDependencies(
  issueId: string,
  database: Database = db,
): Promise<{ dependsOnId: string }[]> {
  return database
    .select({ dependsOnId: issueDependencies.dependsOnId })
    .from(issueDependencies)
    .where(sql`${issueDependencies.issueId} = ${issueId} AND ${issueDependencies.type} IN ('depends_on', 'blocked_by')`);
}

/** Issues that block on `issueId` via depends_on/blocked_by (its dependents). */
export async function getDependentEdges(
  issueId: string,
  database: Database = db,
): Promise<{ issueId: string }[]> {
  return database
    .select({ issueId: issueDependencies.issueId })
    .from(issueDependencies)
    .where(sql`${issueDependencies.dependsOnId} = ${issueId} AND ${issueDependencies.type} IN ('depends_on', 'blocked_by')`);
}

/** Status ids for a set of issues. */
export async function getIssueStatusIds(
  issueIds: string[],
  database: Database = db,
): Promise<{ id: string; statusId: string }[]> {
  return database
    .select({ id: issues.id, statusId: issues.statusId })
    .from(issues)
    .where(inArray(issues.id, issueIds));
}
