import { projects, projectStatuses, preferences, issues, agentSkills, repos, scheduledRuns } from "@agentic-kanban/shared/schema";
import { eq, and } from "drizzle-orm";
import { db } from "../db/index.js";
import type { Database, TransactionClient } from "../db/index.js";

type DbOrTx = Database | TransactionClient;

export async function getAllProjects(database: Database = db) {
  return database.select().from(projects);
}

export async function getProjectByIdRaw(
  projectId: string,
  database: Database = db,
) {
  const rows = await database.select().from(projects).where(eq(projects.id, projectId)).limit(1);
  return rows[0] ?? null;
}

export async function getProjectStatusesByProject(
  projectId: string,
  database: DbOrTx,
) {
  return database.select().from(projectStatuses).where(eq(projectStatuses.projectId, projectId));
}

export async function remapIssueStatus(
  dupProjectId: string,
  dupStatusId: string,
  matchStatusId: string,
  database: DbOrTx,
): Promise<void> {
  await database.update(issues)
    .set({ statusId: matchStatusId })
    .where(and(eq(issues.projectId, dupProjectId), eq(issues.statusId, dupStatusId)));
}

export async function moveIssuesToProject(
  fromProjectId: string,
  toProjectId: string,
  database: DbOrTx,
): Promise<void> {
  await database.update(issues).set({ projectId: toProjectId }).where(eq(issues.projectId, fromProjectId));
}

export async function moveAgentSkillsToProject(
  fromProjectId: string,
  toProjectId: string,
  database: DbOrTx,
): Promise<void> {
  await database.update(agentSkills).set({ projectId: toProjectId }).where(eq(agentSkills.projectId, fromProjectId));
}

export async function moveReposToProject(
  fromProjectId: string,
  toProjectId: string,
  database: DbOrTx,
): Promise<void> {
  await database.update(repos).set({ projectId: toProjectId }).where(eq(repos.projectId, fromProjectId));
}

export async function moveScheduledRunsToProject(
  fromProjectId: string,
  toProjectId: string,
  database: DbOrTx,
): Promise<void> {
  await database.update(scheduledRuns).set({ projectId: toProjectId }).where(eq(scheduledRuns.projectId, fromProjectId));
}

export async function deleteProjectStatusesByProject(
  projectId: string,
  database: DbOrTx,
): Promise<void> {
  await database.delete(projectStatuses).where(eq(projectStatuses.projectId, projectId));
}

export async function deleteProjectRow(
  projectId: string,
  database: DbOrTx,
): Promise<void> {
  await database.delete(projects).where(eq(projects.id, projectId));
}

export async function getActiveProjectPreference(
  database: DbOrTx,
) {
  return database
    .select()
    .from(preferences)
    .where(eq(preferences.key, "activeProjectId"))
    .limit(1);
}

export async function setActiveProjectPreference(
  projectId: string,
  now: string,
  database: DbOrTx,
): Promise<void> {
  await database
    .insert(preferences)
    .values({ key: "activeProjectId", value: projectId, updatedAt: now })
    .onConflictDoUpdate({ target: preferences.key, set: { value: projectId, updatedAt: now } });
}

export async function updateProjectRepoPath(
  projectId: string,
  repoPath: string,
  repoName: string,
  now: string,
  database: Database = db,
): Promise<void> {
  await database
    .update(projects)
    .set({ repoPath, repoName, updatedAt: now })
    .where(eq(projects.id, projectId));
}

export async function getBoardNavigatorSkillId(
  database: Database = db,
): Promise<{ id: string } | undefined> {
  const [navSkill] = await database.select({ id: agentSkills.id }).from(agentSkills)
    .where(eq(agentSkills.name, "board-navigator")).limit(1);
  return navSkill;
}

export async function insertRegisteredProject(
  values: {
    id: string;
    name: string;
    repoPath: string;
    repoName: string;
    defaultBranch: string | null;
    remoteUrl: string | null;
    defaultSkillId: string | null;
    createdAt: string;
    updatedAt: string;
  },
  database: Database = db,
): Promise<void> {
  await database.insert(projects).values(values);
}

export async function upsertActiveProjectPreference(
  projectId: string,
  now: string,
  database: Database = db,
): Promise<void> {
  await database
    .insert(preferences)
    .values({
      key: "activeProjectId",
      value: projectId,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: preferences.key,
      set: { value: projectId, updatedAt: now },
    });
}

export async function getProjectStatusIdsByProject(
  projectId: string,
  database: Database = db,
) {
  return database
    .select({ id: projectStatuses.id })
    .from(projectStatuses)
    .where(eq(projectStatuses.projectId, projectId))
    .limit(1);
}

export async function updateProjectDefaultBranch(
  projectId: string,
  branch: string,
  now: string,
  database: Database = db,
): Promise<void> {
  await database
    .update(projects)
    .set({ defaultBranch: branch, updatedAt: now })
    .where(eq(projects.id, projectId));
}
