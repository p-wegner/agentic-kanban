import { asc, eq, inArray } from "drizzle-orm";
import { issues, workspaces, workflowTransitions, workflowNodes, projectStatuses } from "@agentic-kanban/shared/schema";
import { db } from "../db/index.js";
import type { Database } from "../db/index.js";

export async function getIssueWithStatusName(issueId: string, database: Database = db) {
  return database
    .select({
      id: issues.id,
      createdAt: issues.createdAt,
      statusChangedAt: issues.statusChangedAt,
      statusName: projectStatuses.name,
    })
    .from(issues)
    .leftJoin(projectStatuses, eq(issues.statusId, projectStatuses.id))
    .where(eq(issues.id, issueId))
    .limit(1);
}

export async function getWorkspaceIdsForIssue(issueId: string, database: Database = db) {
  return database
    .select({ id: workspaces.id })
    .from(workspaces)
    .where(eq(workspaces.issueId, issueId));
}

export async function getWorkflowTransitionsForWorkspaces(workspaceIds: string[], database: Database = db) {
  return database
    .select({
      workspaceId: workflowTransitions.workspaceId,
      toNodeId: workflowTransitions.toNodeId,
      createdAt: workflowTransitions.createdAt,
    })
    .from(workflowTransitions)
    .where(inArray(workflowTransitions.workspaceId, workspaceIds))
    .orderBy(asc(workflowTransitions.createdAt));
}

export async function getWorkflowNodeStatusNames(nodeIds: string[], database: Database = db) {
  return database
    .select({ id: workflowNodes.id, statusName: workflowNodes.statusName })
    .from(workflowNodes)
    .where(inArray(workflowNodes.id, nodeIds));
}
