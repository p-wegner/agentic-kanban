import { eq, and, or, inArray, sql, desc } from "drizzle-orm";
import { issues, projectStatuses, issueDependencies, agentSkills, tags, issueTags, workflowNodes, preferences, workspaces } from "@agentic-kanban/shared/schema";
import type { DependencyType } from "@agentic-kanban/shared/schema";
import { db } from "../db/index.js";
import type { Database } from "../db/index.js";
import { getProjectById } from "./project.repository.js";
import { transitionIssueStatus } from "@agentic-kanban/shared/lib/workflow-engine";

export async function getIssueBasics(
  issueId: string,
  database: Database = db,
) {
  const rows = await database
    .select({ id: issues.id, issueNumber: issues.issueNumber, title: issues.title, description: issues.description })
    .from(issues)
    .where(eq(issues.id, issueId))
    .limit(1);
  return rows[0] ?? null;
}

export async function getTerminalStatusIds(
  projectId: string,
  statusNames: string[],
  database: Database = db,
) {
  const rows = await database
    .select({ id: projectStatuses.id })
    .from(projectStatuses)
    .where(and(
      eq(projectStatuses.projectId, projectId),
      inArray(projectStatuses.name, statusNames),
    ));
  return rows.map(s => s.id);
}

export async function getOpenIssuesWithNode(
  projectId: string,
  database: Database = db,
) {
  return database
    .select({
      id: issues.id,
      issueNumber: issues.issueNumber,
      title: issues.title,
      description: issues.description,
      statusId: issues.statusId,
      currentNodeId: issues.currentNodeId,
      currentNodeType: workflowNodes.nodeType,
      touchedFilesJson: issues.touchedFilesJson,
    })
    .from(issues)
    .leftJoin(workflowNodes, eq(issues.currentNodeId, workflowNodes.id))
    .where(eq(issues.projectId, projectId));
}

export async function getSkillPrompt(
  skillName: string,
  projectId: string,
  database: Database = db,
) {
  const rows = await database
    .select({ prompt: agentSkills.prompt })
    .from(agentSkills)
    .where(and(
      eq(agentSkills.name, skillName),
      sql`(${agentSkills.projectId} = ${projectId} OR ${agentSkills.projectId} IS NULL)`,
    ))
    .orderBy(sql`${agentSkills.projectId} IS NULL`)
    .limit(1);
  return rows[0]?.prompt ?? null;
}

export async function insertIssueDependency(
  values: {
    id: string;
    issueId: string;
    dependsOnId: string;
    type: DependencyType;
    createdAt: string;
  },
  database: Database = db,
): Promise<void> {
  await database.insert(issueDependencies).values(values);
}

/**
 * All dependency edges between `issueId` and any of `otherIds`, in EITHER direction.
 * Used by the analyzer's coupling guard to detect a pre-existing sequential
 * (`depends_on`/`blocked_by`) edge before auto-creating a `coupled_with` peer edge.
 */
export async function getDependencyEdgesBetween(
  issueId: string,
  otherIds: string[],
  database: Database = db,
): Promise<Array<{ issueId: string; dependsOnId: string; type: DependencyType }>> {
  if (otherIds.length === 0) return [];
  const rows = await database
    .select({
      issueId: issueDependencies.issueId,
      dependsOnId: issueDependencies.dependsOnId,
      type: issueDependencies.type,
    })
    .from(issueDependencies)
    .where(
      or(
        and(eq(issueDependencies.issueId, issueId), inArray(issueDependencies.dependsOnId, otherIds)),
        and(eq(issueDependencies.dependsOnId, issueId), inArray(issueDependencies.issueId, otherIds)),
      ),
    );
  return rows as Array<{ issueId: string; dependsOnId: string; type: DependencyType }>;
}

export async function getPreferenceValue(
  key: string,
  database: Database = db,
): Promise<string | null> {
  const rows = await database
    .select({ value: preferences.value })
    .from(preferences)
    .where(eq(preferences.key, key))
    .limit(1);
  return rows[0]?.value ?? null;
}

export async function getIssueForTouchedFiles(
  issueId: string,
  database: Database = db,
) {
  const rows = await database
    .select({
      id: issues.id,
      title: issues.title,
      description: issues.description,
      projectId: issues.projectId,
      touchedFilesJson: issues.touchedFilesJson,
    })
    .from(issues)
    .where(eq(issues.id, issueId))
    .limit(1);
  return rows[0] ?? null;
}

export async function updateIssueTouchedFiles(
  issueId: string,
  touchedFilesJson: string,
  database: Database = db,
): Promise<void> {
  await database
    .update(issues)
    .set({ touchedFilesJson })
    .where(eq(issues.id, issueId));
}

export async function getIssuesTouchedFiles(
  issueIds: string[],
  database: Database = db,
) {
  return database
    .select({ id: issues.id, touchedFilesJson: issues.touchedFilesJson })
    .from(issues)
    .where(inArray(issues.id, issueIds));
}

export async function getIssueTitleDescription(
  issueId: string,
  database: Database = db,
) {
  const rows = await database
    .select({ title: issues.title, description: issues.description })
    .from(issues)
    .where(eq(issues.id, issueId))
    .limit(1);
  return rows[0] ?? null;
}

export async function getParentOfDependency(
  issueId: string,
  database: Database = db,
) {
  return database
    .select({ id: issueDependencies.id })
    .from(issueDependencies)
    .where(and(eq(issueDependencies.issueId, issueId), eq(issueDependencies.type, "parent_of")))
    .limit(1);
}

export async function getRecentIssuesWithNode(
  projectId: string,
  database: Database = db,
) {
  return database
    .select({
      title: issues.title,
      description: issues.description,
      statusId: issues.statusId,
      currentNodeId: issues.currentNodeId,
      currentNodeType: workflowNodes.nodeType,
      updatedAt: issues.updatedAt,
    })
    .from(issues)
    .leftJoin(workflowNodes, eq(issues.currentNodeId, workflowNodes.id))
    .where(eq(issues.projectId, projectId))
    .orderBy(desc(issues.updatedAt));
}

export async function getProjectNames(
  projectId: string,
  database: Database = db,
) {
  const project = await getProjectById(projectId, database);
  return project ? { name: project.name, repoName: project.repoName } : null;
}

export async function getStatusIdByName(
  projectId: string,
  name: string,
  database: Database = db,
) {
  const rows = await database
    .select({ id: projectStatuses.id })
    .from(projectStatuses)
    .where(and(eq(projectStatuses.projectId, projectId), eq(projectStatuses.name, name)))
    .limit(1);
  return rows[0]?.id ?? null;
}

export async function getTagByName(
  name: string,
  database: Database = db,
) {
  return database
    .select({ id: tags.id })
    .from(tags)
    .where(eq(tags.name, name))
    .limit(1);
}

export async function insertTag(
  values: {
    id: string;
    name: string;
    color: string;
    isBuiltin: boolean;
    createdAt: string;
  },
  database: Database = db,
): Promise<void> {
  await database.insert(tags).values(values).catch(() => {});
}

export async function getDefaultStatusId(
  projectId: string,
  database: Database = db,
) {
  const rows = await database
    .select({ id: projectStatuses.id })
    .from(projectStatuses)
    .where(eq(projectStatuses.projectId, projectId))
    .orderBy(projectStatuses.sortOrder)
    .limit(1);
  return rows[0]?.id ?? null;
}

export async function insertChildIssue(
  values: {
    id: string;
    issueNumber: number;
    title: string;
    description: string | null;
    priority: string;
    issueType: string;
    skipAutoReview: boolean;
    estimate: null;
    sortOrder: number;
    statusId: string;
    projectId: string;
    createdAt: string;
    updatedAt: string;
  },
  database: Database = db,
): Promise<void> {
  await database.insert(issues).values(values);
}

export async function insertIssueDependencySafe(
  values: {
    id: string;
    issueId: string;
    dependsOnId: string;
    type: DependencyType;
    createdAt: string;
  },
  database: Database = db,
): Promise<void> {
  try {
    await database.insert(issueDependencies).values(values);
  } catch { /* skip duplicate/cycle */ }
}

export async function getIssueTagLink(
  issueId: string,
  tagId: string,
  database: Database = db,
) {
  return database
    .select({ id: issueTags.id })
    .from(issueTags)
    .where(and(eq(issueTags.issueId, issueId), eq(issueTags.tagId, tagId)))
    .limit(1);
}

export async function insertIssueTag(
  values: {
    id: string;
    issueId: string;
    tagId: string;
  },
  database: Database = db,
): Promise<void> {
  await database.insert(issueTags).values(values).catch(() => {});
}

export async function updateIssueDescription(
  issueId: string,
  description: string,
  updatedAt: string,
  database: Database = db,
): Promise<void> {
  await database.update(issues)
    .set({ description, updatedAt })
    .where(eq(issues.id, issueId));
}

/**
 * All `coupled_with` peer edges within a project, with both endpoints' issue numbers.
 * The contract step (#918) uses these to build connected coupled COMPONENTS — the
 * inverse view of the `parent_of`/`child_of` tree that `decomposeEpic` writes. Returns
 * only edges where both endpoints belong to `projectId`.
 */
export async function getCoupledEdges(
  projectId: string,
  database: Database = db,
): Promise<Array<{ issueId: string; dependsOnId: string }>> {
  const rows = await database
    .select({ issueId: issueDependencies.issueId, dependsOnId: issueDependencies.dependsOnId })
    .from(issueDependencies)
    .innerJoin(issues, eq(issueDependencies.issueId, issues.id))
    .where(and(eq(issueDependencies.type, "coupled_with"), eq(issues.projectId, projectId)));
  // Keep only edges whose OTHER endpoint is also in this project (defensive — edges are
  // never cross-project today, but the join above only constrains the `issueId` side).
  if (rows.length === 0) return [];
  const otherIds = [...new Set(rows.map((r) => r.dependsOnId))];
  const inProject = new Set(
    (await database.select({ id: issues.id }).from(issues)
      .where(and(eq(issues.projectId, projectId), inArray(issues.id, otherIds)))).map((r) => r.id),
  );
  return rows.filter((r) => inProject.has(r.dependsOnId));
}

/** Title/description/status/number for a set of issues — the contract proposal's source bodies. */
export async function getIssuesForContract(
  issueIds: string[],
  database: Database = db,
): Promise<Array<{ id: string; issueNumber: number; title: string; description: string | null; statusId: string; projectId: string }>> {
  if (issueIds.length === 0) return [];
  return database
    .select({ id: issues.id, issueNumber: issues.issueNumber, title: issues.title, description: issues.description, statusId: issues.statusId, projectId: issues.projectId })
    .from(issues)
    .where(inArray(issues.id, issueIds));
}

/** Whether any of `issueIds` has an OPEN (non-closed) workspace — a contract must not absorb in-flight work. */
export async function countOpenWorkspacesForIssues(
  issueIds: string[],
  database: Database = db,
): Promise<number> {
  if (issueIds.length === 0) return 0;
  const rows = await database
    .select({ id: workspaces.id })
    .from(workspaces)
    .where(and(inArray(workspaces.issueId, issueIds), sql`${workspaces.status} != 'closed'`));
  return rows.length;
}

/** Move an issue to a status and stamp updatedAt — used to Cancel members absorbed by a contract. */
export async function setIssueStatus(
  issueId: string,
  statusId: string,
  updatedAt: string,
  database: Database = db,
): Promise<void> {
  await transitionIssueStatus(database, issueId, statusId, { now: updatedAt });
}

/** Append text to an issue's description (e.g. the absorbed-into pointer). */
export async function appendIssueDescription(
  issueId: string,
  suffix: string,
  updatedAt: string,
  database: Database = db,
): Promise<void> {
  const existing = await getIssueTitleDescription(issueId, database);
  const next = existing?.description ? `${existing.description}\n\n${suffix}` : suffix;
  await database.update(issues).set({ description: next, updatedAt }).where(eq(issues.id, issueId));
}

/** Set both title and description (the contract survivor takes the merged body). */
export async function updateIssueTitleDescription(
  issueId: string,
  title: string,
  description: string,
  updatedAt: string,
  database: Database = db,
): Promise<void> {
  await database.update(issues).set({ title, description, updatedAt }).where(eq(issues.id, issueId));
}

/** All dependency edges in a project (any type), as `{ from, to, type }` for the contraction planner. */
export async function getProjectDependencyEdges(
  projectId: string,
  database: Database = db,
): Promise<Array<{ from: string; to: string; type: DependencyType }>> {
  const rows = await database
    .select({ from: issueDependencies.issueId, to: issueDependencies.dependsOnId, type: issueDependencies.type })
    .from(issueDependencies)
    .innerJoin(issues, eq(issueDependencies.issueId, issues.id))
    .where(eq(issues.projectId, projectId));
  return rows as Array<{ from: string; to: string; type: DependencyType }>;
}

/** Remove a specific dependency edge by its (issueId, dependsOnId, type) triple. */
export async function removeDependencyEdge(
  issueId: string,
  dependsOnId: string,
  type: DependencyType,
  database: Database = db,
): Promise<void> {
  await database.delete(issueDependencies).where(
    and(
      eq(issueDependencies.issueId, issueId),
      eq(issueDependencies.dependsOnId, dependsOnId),
      eq(issueDependencies.type, type),
    ),
  );
}
