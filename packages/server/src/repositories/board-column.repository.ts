import { issues, projectStatuses, issueDependencies, tags, issueTags, workflowNodes } from "@agentic-kanban/shared/schema";
import { eq, inArray } from "drizzle-orm";
import { db } from "../db/index.js";
import type { Database } from "../db/index.js";

export type GraphEdge = {
  id: string;
  issueId: string;
  dependsOnId: string;
  type: string;
  issueTitle: string;
  issueStatusName: string;
  issueNumber: number | null;
};

/** Dependency edges originating from any of the given issue ids. */
export async function getDependencyRowsForIssues(
  issueIds: string[],
  database: Database = db,
): Promise<{ issueId: string; dependsOnId: string; type: string }[]> {
  if (issueIds.length === 0) return [];
  return database
    .select({
      issueId: issueDependencies.issueId,
      dependsOnId: issueDependencies.dependsOnId,
      type: issueDependencies.type,
    })
    .from(issueDependencies)
    .where(inArray(issueDependencies.issueId, issueIds));
}

/** Status + current-node view for a set of (blocker) issue ids. */
export async function getDependencyStatusViews(
  issueIds: string[],
  database: Database = db,
): Promise<{ id: string; currentNodeId: string | null; currentNodeType: string | null; statusName: string }[]> {
  if (issueIds.length === 0) return [];
  return database
    .select({
      id: issues.id,
      currentNodeId: issues.currentNodeId,
      currentNodeType: workflowNodes.nodeType,
      statusName: projectStatuses.name,
    })
    .from(issues)
    .innerJoin(projectStatuses, eq(issues.statusId, projectStatuses.id))
    .leftJoin(workflowNodes, eq(issues.currentNodeId, workflowNodes.id))
    .where(inArray(issues.id, issueIds));
}

/** Tag rows for a set of issue ids. */
export async function getTagRowsForIssues(
  issueIds: string[],
  database: Database = db,
): Promise<{ issueId: string; id: string; name: string; color: string | null }[]> {
  if (issueIds.length === 0) return [];
  return database
    .select({ issueId: issueTags.issueId, id: tags.id, name: tags.name, color: tags.color })
    .from(issueTags)
    .innerJoin(tags, eq(issueTags.tagId, tags.id))
    .where(inArray(issueTags.issueId, issueIds));
}

/** Full dependency edges (with issue title/status/number) for a set of issue ids. */
export async function getGraphEdgesForIssues(
  issueIds: string[],
  database: Database = db,
): Promise<GraphEdge[]> {
  if (issueIds.length === 0) return [];
  return database
    .select({
      id: issueDependencies.id,
      issueId: issueDependencies.issueId,
      dependsOnId: issueDependencies.dependsOnId,
      type: issueDependencies.type,
      issueTitle: issues.title,
      issueStatusName: projectStatuses.name,
      issueNumber: issues.issueNumber,
    })
    .from(issueDependencies)
    .innerJoin(issues, eq(issueDependencies.issueId, issues.id))
    .innerJoin(projectStatuses, eq(issues.statusId, projectStatuses.id))
    .where(inArray(issueDependencies.issueId, issueIds));
}

/** All dependency edges within a project (for cycle detection). */
export async function getProjectDependencyEdges(
  projectId: string,
  database: Database = db,
): Promise<{ depIssueId: string; depDependsOnId: string }[]> {
  return database
    .select({
      depIssueId: issueDependencies.issueId,
      depDependsOnId: issueDependencies.dependsOnId,
    })
    .from(issueDependencies)
    .innerJoin(issues, eq(issueDependencies.issueId, issues.id))
    .where(eq(issues.projectId, projectId));
}
