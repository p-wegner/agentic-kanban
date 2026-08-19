import { boardStrategyPref, projectPref } from "@agentic-kanban/shared/lib/dynamic-preference-keys";
import { issueDependencies, issues, preferences, projectStatuses, workflowNodes, workspaces } from "@agentic-kanban/shared/schema";
import { and, asc, eq, inArray, ne, sql } from "drizzle-orm";
import { db } from "../db/index.js";
import type { Database } from "../db/index.js";

/**
 * The preference rows the WIP limit is derived from (#654).
 *
 * This used to read ONLY the global `nudge_wip_limit`, so the Dependency Waves panel reported
 * "0/5 WIP, 5 slots open" on a project whose per-project limit AND Strategy Bullseye both said
 * 2 — while the Board Monitor popover two clicks away correctly said 2. The board presented
 * two contradictory WIP numbers, both authoritatively.
 *
 * Returns the whole map rather than one value so the caller can apply the same precedence the
 * monitor uses (`resolveMonitorTunables`) instead of re-deriving a second answer here.
 */
const wipLimitPref = projectPref("wip_limit");

export async function getWipLimitPrefMap(
  projectId: string,
  database: Database = db,
): Promise<Map<string, string>> {
  const keys = [wipLimitPref.key(projectId), boardStrategyPref.key(projectId), "nudge_wip_limit"];
  const prefRows = await database
    .select({ key: preferences.key, value: preferences.value })
    .from(preferences)
    .where(inArray(preferences.key, keys));
  return new Map(prefRows.map((r) => [r.key, r.value] as const));
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
