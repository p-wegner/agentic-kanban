import { projects, projectStatuses, issues, workspaces, preferences, tags, issueTags, scheduledRuns, agentSkills, repos } from "@agentic-kanban/shared/schema";
import { eq, sql, and, inArray } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { db } from "../db/index.js";
import type { Database } from "../db/index.js";
import { deleteWorkspaceCascade } from "./workspace.repository.js";
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

export async function getAllProjects(database: Database = db) {
  return database.select().from(projects);
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
    const issueIds = projectIssues.map((i) => i.id);
    await database.delete(issueTags).where(inArray(issueTags.issueId, issueIds));
    const wsRows = await database.select({ id: workspaces.id }).from(workspaces).where(inArray(workspaces.issueId, issueIds));
    for (const ws of wsRows) {
      await deleteWorkspaceCascade(ws.id, database);
    }
    await database.delete(issues).where(inArray(issues.id, issueIds));
  }

  await database.delete(scheduledRuns).where(eq(scheduledRuns.projectId, projectId));
  await database.delete(agentSkills).where(eq(agentSkills.projectId, projectId));
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
