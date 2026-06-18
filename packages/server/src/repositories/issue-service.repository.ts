import { randomUUID } from "node:crypto";
import { issues, issueTags, issueDependencies, issueArtifacts, issueComments, showdowns, workspaces, projectStatuses, workflowTemplates, workflowNodes, sessions } from "@agentic-kanban/shared/schema";
import type { DependencyType } from "@agentic-kanban/shared/schema";
import { eq, and, or, sql, inArray, desc } from "drizzle-orm";
import { db } from "../db/index.js";
import type { Database, TransactionClient } from "../db/index.js";

/** A drizzle connection that is either the base db or an open transaction. */
type DbOrTx = Database | TransactionClient;

export async function insertIssue(
  values: {
    id: string;
    issueNumber: number;
    title: string;
    description: string | null;
    priority: string;
    issueType: string;
    skipAutoReview: boolean;
    estimate: string | null;
    sortOrder: number;
    workflowTemplateId: string | null;
    externalKey: string | null;
    externalUrl: string | null;
    currentNodeId: string | null;
    statusId: string;
    projectId: string;
    createdAt: string;
    updatedAt: string;
  },
  database: DbOrTx = db,
): Promise<void> {
  await database.insert(issues).values(values);
}

export async function getWorkflowTemplateForProject(
  templateId: string,
  database: DbOrTx = db,
) {
  const rows = await database
    .select({ id: workflowTemplates.id, projectId: workflowTemplates.projectId })
    .from(workflowTemplates)
    .where(eq(workflowTemplates.id, templateId))
    .limit(1);
  return rows[0] ?? null;
}

export async function getMaxIssueNumber(
  projectId: string,
  database: DbOrTx = db,
): Promise<number | null> {
  const maxRow = await database
    .select({ maxNum: sql<number | null>`max(${issues.issueNumber})` })
    .from(issues)
    .where(eq(issues.projectId, projectId));
  return maxRow[0]?.maxNum ?? null;
}

export async function getFirstProjectStatusId(
  projectId: string,
  database: DbOrTx = db,
): Promise<string | null> {
  const rows = await database
    .select({ id: projectStatuses.id })
    .from(projectStatuses)
    .where(eq(projectStatuses.projectId, projectId))
    .limit(1);
  return rows.length === 0 ? null : rows[0].id;
}

export async function insertBatchIssue(
  values: {
    id: string;
    issueNumber: number;
    title: string;
    description: string | null;
    priority: string;
    issueType: string;
    skipAutoReview: boolean;
    estimate: string | null;
    sortOrder: number;
    statusId: string;
    projectId: string;
    createdAt: string;
    updatedAt: string;
  },
  database: DbOrTx = db,
): Promise<void> {
  await database.insert(issues).values(values);
}

export async function insertDependency(
  values: { id: string; issueId: string; dependsOnId: string; type: DependencyType; createdAt: string },
  database: DbOrTx = db,
): Promise<void> {
  await database.insert(issueDependencies).values(values);
}

export async function getIssueWebhookSnapshot(
  id: string,
  database: DbOrTx = db,
) {
  const rows = await database
    .select({
      issueNumber: issues.issueNumber,
      title: issues.title,
      statusId: issues.statusId,
      statusName: projectStatuses.name,
      currentNodeId: issues.currentNodeId,
    })
    .from(issues)
    .leftJoin(projectStatuses, eq(issues.statusId, projectStatuses.id))
    .where(eq(issues.id, id))
    .limit(1);
  return rows[0] ?? null;
}

export async function updateIssueById(
  id: string,
  updates: Record<string, unknown>,
  database: DbOrTx = db,
): Promise<void> {
  await database.update(issues).set(updates).where(eq(issues.id, id));
}

export async function getProjectStatusName(
  statusId: string,
  database: DbOrTx = db,
): Promise<string | null> {
  const statusRow = await database
    .select({ name: projectStatuses.name })
    .from(projectStatuses)
    .where(eq(projectStatuses.id, statusId))
    .limit(1);
  return statusRow[0]?.name ?? null;
}

export async function getIssueCurrentNodeInfo(
  id: string,
  database: DbOrTx = db,
) {
  const rows = await database
    .select({ currentNodeId: issues.currentNodeId, currentNodeType: workflowNodes.nodeType })
    .from(issues)
    .leftJoin(workflowNodes, eq(issues.currentNodeId, workflowNodes.id))
    .where(eq(issues.id, id))
    .limit(1);
  return rows[0] ?? null;
}

export async function closeOpenWorkspacesForIssue(
  id: string,
  closedAt: string,
  database: DbOrTx = db,
): Promise<void> {
  await database
    .update(workspaces)
    .set({ status: "closed", closedAt, updatedAt: closedAt })
    .where(and(eq(workspaces.issueId, id), sql`${workspaces.status} != 'closed'`));
}

export async function getIssueIdsAndProjects(
  ids: string[],
  database: DbOrTx = db,
) {
  return database
    .select({ id: issues.id, projectId: issues.projectId })
    .from(issues)
    .where(inArray(issues.id, ids));
}

export async function updateIssuesByIds(
  ids: string[],
  updates: Record<string, unknown>,
  database: DbOrTx = db,
): Promise<void> {
  await database.update(issues).set(updates).where(inArray(issues.id, ids));
}

export async function deleteIssueArtifactsForIssue(
  id: string,
  database: DbOrTx = db,
): Promise<void> {
  await database.delete(issueArtifacts).where(eq(issueArtifacts.issueId, id));
}

export async function deleteIssueCommentsForIssue(
  id: string,
  database: DbOrTx = db,
): Promise<void> {
  await database.delete(issueComments).where(eq(issueComments.issueId, id));
}

export async function getWorkspaceIdsForIssue(
  id: string,
  database: DbOrTx = db,
) {
  return database.select({ id: workspaces.id }).from(workspaces).where(eq(workspaces.issueId, id));
}

export async function deleteIssueTagsForIssue(
  id: string,
  database: DbOrTx = db,
): Promise<void> {
  await database.delete(issueTags).where(eq(issueTags.issueId, id));
}

export async function deleteDependenciesTouchingIssue(
  id: string,
  database: DbOrTx = db,
): Promise<void> {
  await database.delete(issueDependencies).where(or(eq(issueDependencies.issueId, id), eq(issueDependencies.dependsOnId, id)));
}

export async function deleteShowdownsForIssue(
  id: string,
  database: DbOrTx = db,
): Promise<void> {
  await database.delete(showdowns).where(eq(showdowns.issueId, id));
}

export async function deleteIssueRow(
  id: string,
  database: DbOrTx = db,
): Promise<void> {
  await database.delete(issues).where(eq(issues.id, id));
}

export async function getIssueProjectIdsPair(
  issueId: string,
  dependsOnId: string,
  database: DbOrTx = db,
) {
  return Promise.all([
    database.select({ projectId: issues.projectId }).from(issues).where(eq(issues.id, issueId)).limit(1),
    database.select({ projectId: issues.projectId }).from(issues).where(eq(issues.id, dependsOnId)).limit(1),
  ]);
}

export async function deleteDependencyByIdAndIssue(
  depId: string,
  issueId: string,
  database: DbOrTx = db,
): Promise<void> {
  await database.delete(issueDependencies)
    .where(and(eq(issueDependencies.id, depId), eq(issueDependencies.issueId, issueId)));
}

export async function getIssueIdsAndProjectsForBatch(
  issueIds: string[],
  database: DbOrTx = db,
) {
  return database
    .select({ id: issues.id, projectId: issues.projectId })
    .from(issues)
    .where(inArray(issues.id, issueIds));
}

export async function getDependencyRowsForProjects(
  projectIds: string[],
  database: DbOrTx = db,
) {
  return database
    .select({
      id: issueDependencies.id,
      issueId: issueDependencies.issueId,
      dependsOnId: issueDependencies.dependsOnId,
      type: issueDependencies.type,
      projectId: issues.projectId,
    })
    .from(issueDependencies)
    .innerJoin(issues, eq(issueDependencies.issueId, issues.id))
    .where(inArray(issues.projectId, projectIds));
}

export async function deleteDependencyById(
  id: string,
  database: DbOrTx = db,
): Promise<void> {
  await database.delete(issueDependencies).where(eq(issueDependencies.id, id));
}

export async function insertIssueArtifact(
  values: {
    id: string;
    issueId: string;
    workspaceId: string | null;
    type: string;
    mimeType: string | null;
    content: string;
    caption: string | null;
  },
  database: DbOrTx = db,
): Promise<void> {
  await database.insert(issueArtifacts).values(values);
}

export async function getLatestSessionsForWorkspaces(
  wsIds: string[],
  database: DbOrTx = db,
) {
  if (wsIds.length === 0) return [];
  return database
    .select({
      workspaceId: sessions.workspaceId,
      status: sessions.status,
      startedAt: sessions.startedAt,
      endedAt: sessions.endedAt,
      triggerType: sessions.triggerType,
    })
    .from(sessions)
    .where(inArray(sessions.workspaceId, wsIds))
    .orderBy(desc(sessions.startedAt));
}

export async function getDuplicateSourceIssue(
  sourceId: string,
  database: DbOrTx = db,
) {
  const rows = await database
    .select({
      projectId: issues.projectId,
      title: issues.title,
      description: issues.description,
      priority: issues.priority,
      issueType: issues.issueType,
    })
    .from(issues)
    .where(eq(issues.id, sourceId))
    .limit(1);
  return rows[0] ?? null;
}

export async function getArchivedStatusId(
  projectId: string,
  database: DbOrTx = db,
): Promise<string | null> {
  const rows = await database
    .select({ id: projectStatuses.id })
    .from(projectStatuses)
    .where(and(eq(projectStatuses.projectId, projectId), eq(projectStatuses.name, "Archived")))
    .limit(1);
  return rows.length === 0 ? null : rows[0].id;
}

export async function getDoneStatusIds(
  projectId: string,
  database: DbOrTx = db,
): Promise<string[]> {
  const rows = await database
    .select({ id: projectStatuses.id })
    .from(projectStatuses)
    .where(and(eq(projectStatuses.projectId, projectId), eq(projectStatuses.name, "Done")));
  return rows.map((s) => s.id);
}

export async function getDoneCandidateIssues(
  projectId: string,
  doneStatusIds: string[],
  database: DbOrTx = db,
) {
  return database
    .select({ id: issues.id, statusChangedAt: issues.statusChangedAt, createdAt: issues.createdAt })
    .from(issues)
    .where(and(eq(issues.projectId, projectId), inArray(issues.statusId, doneStatusIds)));
}

export async function archiveIssuesByIds(
  issueIds: string[],
  archivedStatusId: string,
  now: string,
  database: DbOrTx = db,
): Promise<void> {
  await database
    .update(issues)
    .set({ statusId: archivedStatusId, statusChangedAt: now, updatedAt: now })
    .where(inArray(issues.id, issueIds));
}
