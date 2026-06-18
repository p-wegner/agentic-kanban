import { eq, inArray } from "drizzle-orm";
import {
  issueDependencies,
  issues,
  projectStatuses,
  workflowNodes,
} from "@agentic-kanban/shared/schema";
import { db } from "../db/index.js";
import type { Database } from "../db/index.js";

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

/** Issue rows (with status + current workflow node type) for a set of ids. */
export async function getScopedIssueRows(
  scopedIds: string[],
  database: Database = db,
): Promise<ScopedIssueRow[]> {
  if (scopedIds.length === 0) return [];
  return database
    .select({
      id: issues.id,
      issueNumber: issues.issueNumber,
      title: issues.title,
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
