import { issues, preferences, projectStatuses, workspaces } from "@agentic-kanban/shared/schema";
import { and, eq, inArray, ne, sql } from "drizzle-orm";
import { db } from "../db/index.js";
import type { Database } from "../db/index.js";
import { ACTIVE_WORKSPACE_STATUSES } from "@agentic-kanban/shared";

/** Raw value of the `board_strategy_<projectId>` preference, if any. */
export async function getStrategyBullseyePref(
  projectId: string,
  database: Database = db,
): Promise<string | null> {
  const rows = await database
    .select({ value: preferences.value })
    .from(preferences)
    .where(eq(preferences.key, `board_strategy_${projectId}`))
    .limit(1);
  return rows[0]?.value ?? null;
}

/** Count of distinct issues with an active workspace in a project. */
export async function countActiveWorkspaceIssues(
  projectId: string,
  database: Database = db,
): Promise<number> {
  const rows = await database
    .select({ count: sql<number>`count(distinct ${issues.id})` })
    .from(issues)
    .innerJoin(workspaces, eq(workspaces.issueId, issues.id))
    .where(and(
      eq(issues.projectId, projectId),
      inArray(workspaces.status, [...ACTIVE_WORKSPACE_STATUSES]),
    ));
  return Number(rows[0]?.count ?? 0);
}

/** All statuses (id + name) for a project. */
export async function getProjectStatusList(
  projectId: string,
  database: Database = db,
): Promise<{ id: string; name: string }[]> {
  return database
    .select({ id: projectStatuses.id, name: projectStatuses.name })
    .from(projectStatuses)
    .where(eq(projectStatuses.projectId, projectId));
}

/** Issues in a project that belong to the given status ids. */
export async function getIssuesByStatusIds(
  projectId: string,
  statusIds: string[],
  database: Database = db,
): Promise<{ id: string; issueNumber: number | null; title: string; priority: string | null; statusName: string }[]> {
  if (statusIds.length === 0) return [];
  return database
    .select({
      id: issues.id,
      issueNumber: issues.issueNumber,
      title: issues.title,
      priority: issues.priority,
      statusName: projectStatuses.name,
    })
    .from(issues)
    .innerJoin(projectStatuses, eq(issues.statusId, projectStatuses.id))
    .where(and(
      eq(issues.projectId, projectId),
      inArray(issues.statusId, statusIds),
    ));
}

/** Issue ids (among the given set) that have a non-closed workspace. */
export async function getIssueIdsWithOpenWorkspace(
  issueIds: string[],
  database: Database = db,
): Promise<{ issueId: string }[]> {
  if (issueIds.length === 0) return [];
  return database
    .select({ issueId: workspaces.issueId })
    .from(workspaces)
    .where(and(
      inArray(workspaces.issueId, issueIds),
      ne(workspaces.status, "closed"),
    ));
}
