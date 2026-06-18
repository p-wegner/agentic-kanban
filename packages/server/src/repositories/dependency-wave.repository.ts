import { issueDependencies, issues, preferences, projectStatuses, workflowNodes, workspaces } from "@agentic-kanban/shared/schema";
import { and, asc, eq, inArray, ne, sql } from "drizzle-orm";
import { db } from "../db/index.js";
import type { Database } from "../db/index.js";

export async function getWipLimitPref(
  database: Database = db,
): Promise<string | undefined> {
  const prefRows = await database
    .select({ value: preferences.value })
    .from(preferences)
    .where(eq(preferences.key, "nudge_wip_limit"))
    .limit(1);
  return prefRows[0]?.value;
}

export async function getInProgressStatusIds(
  projectId: string,
  database: Database = db,
): Promise<string[]> {
  const inProgressStatuses = await database
    .select({ id: projectStatuses.id })
    .from(projectStatuses)
    .where(and(eq(projectStatuses.projectId, projectId), eq(projectStatuses.name, "In Progress")));
  return inProgressStatuses.map((status) => status.id);
}

export async function getActiveWipCount(
  projectId: string,
  inProgressStatusIds: string[],
  database: Database = db,
): Promise<number> {
  const activeWipRows = await database
    .select({ count: sql<number>`count(distinct ${issues.id})` })
    .from(issues)
    .innerJoin(workspaces, eq(workspaces.issueId, issues.id))
    .where(and(
      eq(issues.projectId, projectId),
      inArray(issues.statusId, inProgressStatusIds),
      ne(workspaces.status, "closed"),
    ));
  return Number(activeWipRows[0]?.count ?? 0);
}

export async function getProjectIssuesForWave(
  projectId: string,
  database: Database = db,
) {
  return database
    .select({
      id: issues.id,
      issueNumber: issues.issueNumber,
      title: issues.title,
      statusName: projectStatuses.name,
      statusId: issues.statusId,
      sortOrder: issues.sortOrder,
      currentNodeId: issues.currentNodeId,
      currentNodeType: workflowNodes.nodeType,
    })
    .from(issues)
    .innerJoin(projectStatuses, eq(issues.statusId, projectStatuses.id))
    .leftJoin(workflowNodes, eq(issues.currentNodeId, workflowNodes.id))
    .where(eq(issues.projectId, projectId))
    .orderBy(asc(projectStatuses.sortOrder), asc(issues.sortOrder), asc(issues.issueNumber));
}

export async function getOpenWorkspaceIssueIds(
  openIssueIds: string[],
  database: Database = db,
): Promise<Array<{ issueId: string }>> {
  if (openIssueIds.length === 0) return [];
  return database
    .select({ issueId: workspaces.issueId })
    .from(workspaces)
    .where(and(inArray(workspaces.issueId, openIssueIds), ne(workspaces.status, "closed")));
}

export async function getWaveDependencyRows(
  projectId: string,
  hasIssues: boolean,
  database: Database = db,
): Promise<Array<{ id: string; issueId: string; dependsOnId: string; type: string }>> {
  if (!hasIssues) return [];
  return database
    .select({
      id: issueDependencies.id,
      issueId: issueDependencies.issueId,
      dependsOnId: issueDependencies.dependsOnId,
      type: issueDependencies.type,
    })
    .from(issueDependencies)
    .innerJoin(issues, eq(issueDependencies.issueId, issues.id))
    .where(eq(issues.projectId, projectId));
}

export async function getUpstreamWorkspaceLandingRows(
  upstreamIds: string[],
  database: Database = db,
): Promise<Array<{ issueId: string; mergedAt: string | null; isDirect: boolean }>> {
  if (upstreamIds.length === 0) return [];
  return database
    .select({ issueId: workspaces.issueId, mergedAt: workspaces.mergedAt, isDirect: workspaces.isDirect })
    .from(workspaces)
    .where(inArray(workspaces.issueId, upstreamIds));
}
