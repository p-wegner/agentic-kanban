import { and, eq, inArray } from "drizzle-orm";
import {
  issueDependencies,
  issues,
  projectStatuses,
  workflowNodes,
} from "@agentic-kanban/shared/schema";
import { db } from "../db/index.js";
import type { Database } from "../db/index.js";
import { issueIdentityColumns } from "./projections.js";

export type ScopedIssueRow = {
  id: string;
  issueNumber: number | null;
  title: string;
  projectId: string;
  statusName: string | null;
  currentNodeId: string | null;
  currentNodeType: string | null;
};

/** The `parent_of`/outgoing dependency edges of a meta issue (drive scope resolution). */
export async function getMetaIssueDependencyEdges(
  metaIssueId: string,
  database: Database = db,
): Promise<{ childId: string; type: string }[]> {
  return database
    .select({ childId: issueDependencies.dependsOnId, type: issueDependencies.type })
    .from(issueDependencies)
    .where(eq(issueDependencies.issueId, metaIssueId));
}

/**
 * The epic's existing children (parent_of edges: issueId = epic, dependsOnId = child),
 * with their title and current status name — feeds the decompose prompt so a
 * re-decomposition can see what already exists (#1131).
 */
export async function getEpicChildrenWithStatus(
  issueId: string,
  database: Database = db,
): Promise<Array<{ issueNumber: number; title: string; statusName: string }>> {
  const rows = await database
    .select({
      issueNumber: issues.issueNumber,
      title: issues.title,
      statusName: projectStatuses.name,
    })
    .from(issueDependencies)
    .innerJoin(issues, eq(issues.id, issueDependencies.dependsOnId))
    .innerJoin(projectStatuses, eq(projectStatuses.id, issues.statusId))
    .where(and(eq(issueDependencies.issueId, issueId), eq(issueDependencies.type, "parent_of")))
    .orderBy(issues.issueNumber);
  // issueNumber is nullable in the schema but always assigned at creation time (see the
  // root CLAUDE.md's "Issue numbers" note); a null here would mean corrupt data, so it is
  // filtered out rather than surfaced as a fake number to the prompt.
  return rows.filter((r): r is { issueNumber: number; title: string; statusName: string } => r.issueNumber != null);
}

/** Issue rows (with status + current workflow node type) for a set of ids. */
export async function getScopedIssueRows(
  scopedIds: string[],
  database: Database = db,
): Promise<ScopedIssueRow[]> {
  if (scopedIds.length === 0) return [];
  return database
    .select({
      ...issueIdentityColumns,
      projectId: issues.projectId,
      statusName: projectStatuses.name,
      currentNodeId: issues.currentNodeId,
      currentNodeType: workflowNodes.nodeType,
    })
    .from(issues)
    .innerJoin(projectStatuses, eq(issues.statusId, projectStatuses.id))
    .leftJoin(workflowNodes, eq(issues.currentNodeId, workflowNodes.id))
    .where(inArray(issues.id, scopedIds));
}

/** Dependency edges originating from any of the given scoped issue ids. */
export async function getScopedDependencyEdges(
  scopedIds: string[],
  database: Database = db,
): Promise<{ issueId: string; dependsOnId: string; type: string }[]> {
  if (scopedIds.length === 0) return [];
  return database
    .select({
      issueId: issueDependencies.issueId,
      dependsOnId: issueDependencies.dependsOnId,
      type: issueDependencies.type,
    })
    .from(issueDependencies)
    .where(inArray(issueDependencies.issueId, scopedIds));
}
