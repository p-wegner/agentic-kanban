import { eq, and, or, inArray, sql, desc } from "drizzle-orm";
import { issues, projectStatuses, issueDependencies, agentSkills, tags, issueTags, workflowNodes } from "@agentic-kanban/shared/schema";
import type { DependencyType } from "@agentic-kanban/shared/schema";
import { db } from "../db/index.js";
import type { Database } from "../db/index.js";
import { getProjectById } from "./project.repository.js";
import { getStatusIdsByName } from "./project-status.repository.js";
import { getPreference as canonicalGetPreference } from "./preferences.repository.js";
import { issueTextColumns } from "./projections.js";
import { firstRow } from "../lib/first-row.js";

// Decomposed (#1628): these moved to ./issue-ai-touched-files.repository.js; re-exported so import paths are unchanged.
export { getIssueForTouchedFiles, updateIssueTouchedFiles, getIssuesTouchedFiles } from "./issue-ai-touched-files.repository.js";

// Decomposed (#1628): these moved to ./issue-ai-contract.repository.js; re-exported so import paths are unchanged.
export { getIssueTitleDescription, getCoupledEdges, getIssuesForContract, countOpenWorkspacesForIssues, setIssueStatus, appendIssueDescription, updateIssueTitleDescription, getProjectDependencyEdges, removeDependencyEdge } from "./issue-ai-contract.repository.js";

export async function getIssueBasics(
  issueId: string,
  database: Database = db,
) {
  return firstRow(
    database
      .select({ id: issues.id, issueNumber: issues.issueNumber, title: issues.title, description: issues.description })
      .from(issues)
      .where(eq(issues.id, issueId))
      .limit(1)
  );
}



/** #502: one query, in project-status.repository. Kept as a named re-export so callers are unchanged. */
export async function getTerminalStatusIds(
  projectId: string,
  statusNames: string[],
  database: Database = db,
): Promise<string[]> {
  return getStatusIdsByName(projectId, statusNames, database);
}



export async function getOpenIssuesWithNode(
  projectId: string,
  database: Database = db,
) {
  return database
    .select({
      ...issueTextColumns,
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
  return (await firstRow(
    database
      .select({ prompt: agentSkills.prompt })
      .from(agentSkills)
      .where(and(
        eq(agentSkills.name, skillName),
        sql`(${agentSkills.projectId} = ${projectId} OR ${agentSkills.projectId} IS NULL)`,
      ))
      .orderBy(sql`${agentSkills.projectId} IS NULL`)
      .limit(1)
  ))?.prompt ?? null;
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



/** #613: delegates to the canonical reader (which records the db:getPreference metric). */
export async function getPreferenceValue(key: string, database: Database = db): Promise<string | null> {
  return canonicalGetPreference(key, database);
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
  return (await firstRow(
    database
      .select({ id: projectStatuses.id })
      .from(projectStatuses)
      .where(and(eq(projectStatuses.projectId, projectId), eq(projectStatuses.name, name)))
      .limit(1)
  ))?.id ?? null;
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
  return (await firstRow(
    database
      .select({ id: projectStatuses.id })
      .from(projectStatuses)
      .where(eq(projectStatuses.projectId, projectId))
      .orderBy(projectStatuses.sortOrder)
      .limit(1)
  ))?.id ?? null;
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
