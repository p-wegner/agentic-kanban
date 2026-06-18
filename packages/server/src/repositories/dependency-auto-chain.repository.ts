import { randomUUID } from "node:crypto";
import { issueComments, issueDependencies, issues, issueTags, projectStatuses, tags, workflowNodes, workspaces } from "@agentic-kanban/shared/schema";
import { and, asc, eq, inArray, ne, sql } from "drizzle-orm";
import { db } from "../db/index.js";
import type { Database } from "../db/index.js";

type DependencyType = "depends_on" | "blocked_by" | "related_to" | "duplicates" | "parent_of" | "child_of";

export async function getProjectStatusesForAutoChain(
  projectId: string,
  database: Database = db,
) {
  return database
    .select({ id: projectStatuses.id, name: projectStatuses.name, sortOrder: projectStatuses.sortOrder })
    .from(projectStatuses)
    .where(eq(projectStatuses.projectId, projectId));
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

export async function getAutoChainCandidates(
  args: {
    projectId: string;
    completedIssueId: string;
    triggerTypes: readonly DependencyType[];
    startableStatusIds: string[];
  },
  database: Database = db,
) {
  return database
    .select({
      id: issues.id,
      title: issues.title,
      issueNumber: issues.issueNumber,
      projectId: issues.projectId,
      statusSortOrder: projectStatuses.sortOrder,
      sortOrder: issues.sortOrder,
    })
    .from(issueDependencies)
    .innerJoin(issues, eq(issueDependencies.issueId, issues.id))
    .innerJoin(projectStatuses, eq(issues.statusId, projectStatuses.id))
    .where(and(
      eq(issues.projectId, args.projectId),
      eq(issueDependencies.dependsOnId, args.completedIssueId),
      inArray(issueDependencies.type, args.triggerTypes),
      inArray(issues.statusId, args.startableStatusIds),
    ))
    .orderBy(asc(projectStatuses.sortOrder), asc(issues.sortOrder), asc(issues.issueNumber));
}

export async function getProjectDependencyRows(
  projectId: string,
  database: Database = db,
) {
  return database
    .select({
      issueId: issueDependencies.issueId,
      dependsOnId: issueDependencies.dependsOnId,
      type: issueDependencies.type,
    })
    .from(issueDependencies)
    .innerJoin(issues, eq(issueDependencies.issueId, issues.id))
    .where(eq(issues.projectId, projectId));
}

export async function hasSkipAutoStartTag(
  candidateId: string,
  skipTagName: string,
  database: Database = db,
): Promise<boolean> {
  const skipTagRows = await database
    .select({ id: tags.id })
    .from(issueTags)
    .innerJoin(tags, eq(issueTags.tagId, tags.id))
    .where(and(eq(issueTags.issueId, candidateId), eq(tags.name, skipTagName)))
    .limit(1);
  return skipTagRows.length > 0;
}

export async function hasExistingOpenWorkspace(
  candidateId: string,
  database: Database = db,
): Promise<boolean> {
  const existingOpenWorkspace = await database
    .select({ id: workspaces.id })
    .from(workspaces)
    .where(and(eq(workspaces.issueId, candidateId), ne(workspaces.status, "closed")))
    .limit(1);
  return existingOpenWorkspace.length > 0;
}

export async function getBlockingDependencyIds(
  candidateId: string,
  blockingDependencyTypes: readonly DependencyType[],
  database: Database = db,
): Promise<string[]> {
  const blockingDeps = await database
    .select({ dependsOnId: issueDependencies.dependsOnId })
    .from(issueDependencies)
    .where(and(
      eq(issueDependencies.issueId, candidateId),
      inArray(issueDependencies.type, blockingDependencyTypes),
    ));
  return [...new Set(blockingDeps.map((dep) => dep.dependsOnId))];
}

export async function getBlockerStatuses(
  blockerIds: string[],
  database: Database = db,
) {
  return database
    .select({
      id: issues.id,
      statusName: projectStatuses.name,
      currentNodeId: issues.currentNodeId,
      currentNodeType: workflowNodes.nodeType,
    })
    .from(issues)
    .innerJoin(projectStatuses, eq(issues.statusId, projectStatuses.id))
    .leftJoin(workflowNodes, eq(issues.currentNodeId, workflowNodes.id))
    .where(inArray(issues.id, blockerIds));
}

export async function insertAutoChainAuditComment(
  args: {
    issueId: string;
    workspaceId?: string | null;
    body: string;
    payload: Record<string, unknown>;
  },
  database: Database = db,
): Promise<void> {
  await database.insert(issueComments).values({
    id: randomUUID(),
    issueId: args.issueId,
    workspaceId: args.workspaceId ?? null,
    kind: "note",
    author: "butler",
    body: args.body,
    payload: JSON.stringify({ trigger: "dependency-auto-chain", ...args.payload }),
    createdAt: new Date().toISOString(),
  });
}
