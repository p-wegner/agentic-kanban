import { projects, projectStatuses, issues, preferences, scheduledRuns, scheduledRunHistory, agentSkills, repos, flakyTests, qualityMetrics, projectScriptShortcuts, boardHealthEvents, workflowTemplates, workspaces } from "@agentic-kanban/shared/schema";
import { eq, sql, and, isNull, gte } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { db } from "../db/index.js";
import type { Database } from "../db/index.js";
import { deleteIssueCascade } from "./issue-service.repository.js";
import { initializeProjectStatuses } from "./issue.repository.js";

export async function getProjectById(
  projectId: string,
  database: Database = db,
) {
  const rows = await database.select().from(projects).where(eq(projects.id, projectId)).limit(1);
  return rows[0] ?? null;
}

export async function getProjectByRepoPath(
  repoPath: string,
  database: Database = db,
) {
  const rows = await database
    .select({ id: projects.id, name: projects.name })
    .from(projects)
    .where(eq(projects.repoPath, repoPath))
    .limit(1);
  return rows[0] ?? null;
}

export async function getAllProjects(
  database: Database = db,
  opts: { includeArchived?: boolean } = {},
) {
  if (opts.includeArchived) {
    return database.select().from(projects);
  }
  return database.select().from(projects).where(isNull(projects.archivedAt));
}

export async function setProjectArchived(
  projectId: string,
  archived: boolean,
  database: Database = db,
): Promise<void> {
  await database
    .update(projects)
    .set({ archivedAt: archived ? new Date().toISOString() : null, updatedAt: new Date().toISOString() })
    .where(eq(projects.id, projectId));
}

export async function getProjectStatuses(
  projectId: string,
  database: Database = db,
) {
  return database
    .select()
    .from(projectStatuses)
    .where(eq(projectStatuses.projectId, projectId))
    .orderBy(projectStatuses.sortOrder);
}

export async function insertProject(
  id: string,
  values: {
    name: string;
    description?: string | null;
    color?: string | null;
    repoPath: string;
    repoName: string;
    defaultBranch: string | null;
    remoteUrl: string | null;
    defaultSkillId?: string | null;
  },
  database: Database = db,
) {
  const now = new Date().toISOString();
  await database.insert(projects).values({
    id,
    name: values.name,
    description: values.description ?? null,
    color: values.color ?? null,
    repoPath: values.repoPath,
    repoName: values.repoName,
    defaultBranch: values.defaultBranch,
    remoteUrl: values.remoteUrl,
    defaultSkillId: values.defaultSkillId ?? null,
    createdAt: now,
    updatedAt: now,
  });

  await initializeProjectStatuses(id, now, database);
  return { id, name: values.name, repoPath: values.repoPath, defaultBranch: values.defaultBranch };
}

export async function deleteProjectCascade(
  projectId: string,
  database: Database = db,
): Promise<void> {
  const projectIssues = await database.select({ id: issues.id }).from(issues).where(eq(issues.projectId, projectId));
  if (projectIssues.length > 0) {
    for (const issue of projectIssues) {
      await deleteIssueCascade(issue.id, database);
    }
  }

  await database.delete(scheduledRunHistory).where(eq(scheduledRunHistory.projectId, projectId));
  await database.delete(scheduledRuns).where(eq(scheduledRuns.projectId, projectId));
  await database.delete(projectScriptShortcuts).where(eq(projectScriptShortcuts.projectId, projectId));
  await database.delete(workflowTemplates).where(eq(workflowTemplates.projectId, projectId));
  await database.update(projects).set({ defaultSkillId: null }).where(eq(projects.id, projectId));
  await database.delete(agentSkills).where(eq(agentSkills.projectId, projectId));
  await database.delete(flakyTests).where(eq(flakyTests.projectId, projectId));
  await database.delete(qualityMetrics).where(eq(qualityMetrics.projectId, projectId));
  await database.delete(boardHealthEvents).where(eq(boardHealthEvents.projectId, projectId));
  await database.delete(repos).where(eq(repos.projectId, projectId));
  await database.delete(projectStatuses).where(eq(projectStatuses.projectId, projectId));
  await database.delete(preferences).where(and(eq(preferences.key, "activeProjectId"), eq(preferences.value, projectId)));
  await database.delete(projects).where(eq(projects.id, projectId));
}

export async function getProjectStats(
  projectId: string,
  database: Database = db,
) {
  return database
    .select({ statusName: projectStatuses.name, count: sql<number>`count(*)` })
    .from(issues)
    .leftJoin(projectStatuses, eq(issues.statusId, projectStatuses.id))
    .where(eq(issues.projectId, projectId))
    .groupBy(projectStatuses.name);
}

/**
 * Rows backing the per-provider throughput digest: Done issues (moved to Done
 * within the window) joined to their merged workspace's provider attribution.
 * Pure read — the route owns the dedup/percentile aggregation over these rows.
 */
export async function getDoneIssueProviderAttribution(
  projectId: string,
  cutoffDay: string,
  database: Database = db,
) {
  return database
    .select({
      issueId: issues.id,
      issueCreatedAt: issues.createdAt,
      statusChangedAt: issues.statusChangedAt,
      provider: workspaces.provider,
      claudeProfile: workspaces.claudeProfile,
      mergedAt: workspaces.mergedAt,
    })
    .from(issues)
    .innerJoin(projectStatuses, eq(issues.statusId, projectStatuses.id))
    .innerJoin(workspaces, eq(issues.id, workspaces.issueId))
    .where(
      and(
        eq(issues.projectId, projectId),
        eq(projectStatuses.name, "Done"),
        gte(issues.statusChangedAt, cutoffDay),
      ),
    );
}

export async function createProjectStatus(
  projectId: string,
  name: string,
  sortOrder: number,
  database: Database = db,
) {
  const id = randomUUID();
  const now = new Date().toISOString();
  await database.insert(projectStatuses).values({
    id,
    projectId,
    name,
    sortOrder,
    createdAt: now,
  });
  return { id, projectId, name };
}

export async function updateProjectStatusSortOrder(
  projectId: string,
  statusId: string,
  sortOrder: number,
  database: Database = db,
): Promise<{ success: true } | { error: string; status: number }> {
  const rows = await database
    .select()
    .from(projectStatuses)
    .where(and(eq(projectStatuses.id, statusId), eq(projectStatuses.projectId, projectId)));

  if (rows.length === 0) {
    return { error: "Status not found", status: 404 };
  }

  await database
    .update(projectStatuses)
    .set({ sortOrder })
    .where(and(eq(projectStatuses.id, statusId), eq(projectStatuses.projectId, projectId)));

  return { success: true };
}

export async function deleteProjectStatus(
  projectId: string,
  statusId: string,
  database: Database = db,
): Promise<{ success: true } | { error: string; status: number }> {
  const statusRows = await database
    .select()
    .from(projectStatuses)
    .where(and(eq(projectStatuses.id, statusId), eq(projectStatuses.projectId, projectId)));

  if (statusRows.length === 0) {
    return { error: "Status not found", status: 404 };
  }

  const linkedIssues = await database
    .select({ id: issues.id })
    .from(issues)
    .where(eq(issues.statusId, statusId))
    .limit(1);

  if (linkedIssues.length > 0) {
    return { error: "Cannot delete status with linked issues", status: 409 };
  }

  await database.delete(projectStatuses).where(eq(projectStatuses.id, statusId));
  return { success: true };
}

/** A single project status by its id (no project scoping), or null. */
export async function getProjectStatusById(statusId: string, database: Database = db) {
  const rows = await database.select().from(projectStatuses).where(eq(projectStatuses.id, statusId)).limit(1);
  return rows[0] ?? null;
}

/** Delete a project status by id alone (caller has already validated). */
export async function deleteProjectStatusById(statusId: string, database: Database = db): Promise<void> {
  await database.delete(projectStatuses).where(eq(projectStatuses.id, statusId));
}

/** A project by its exact name (first match), or null. */
export async function getProjectByName(name: string, database: Database = db) {
  const rows = await database.select().from(projects).where(eq(projects.name, name)).limit(1);
  return rows[0] ?? null;
}
