import { eq, inArray } from "drizzle-orm";
import { showdowns, workspaces, issues, agentSkills } from "@agentic-kanban/shared/schema";
import { db } from "../db/index.js";
import type { Database } from "../db/index.js";
import { getProjectById } from "./project.repository.js";

export async function getIssueForShowdown(
  issueId: string,
  database: Database = db,
) {
  const rows = await database
    .select({ id: issues.id, projectId: issues.projectId, issueNumber: issues.issueNumber, title: issues.title })
    .from(issues)
    .where(eq(issues.id, issueId))
    .limit(1);
  return rows[0] ?? null;
}

export async function getProjectDefaultBranch(
  projectId: string,
  database: Database = db,
) {
  const project = await getProjectById(projectId, database);
  return project ? { defaultBranch: project.defaultBranch } : null;
}

export async function insertShowdown(
  values: {
    id: string;
    issueId: string;
    status: string;
    winnerWorkspaceId: string | null;
    createdAt: string;
    updatedAt: string;
  },
  database: Database = db,
): Promise<void> {
  await database.insert(showdowns).values({
    id: values.id,
    issueId: values.issueId,
    status: values.status,
    winnerWorkspaceId: values.winnerWorkspaceId,
    createdAt: values.createdAt,
    updatedAt: values.updatedAt,
  });
}

export async function tagWorkspaceWithShowdown(
  workspaceId: string,
  showdownId: string,
  showdownLabel: string,
  database: Database = db,
): Promise<void> {
  await database.update(workspaces).set({
    showdownId,
    showdownLabel,
  }).where(eq(workspaces.id, workspaceId));
}

export async function getAgentSkillName(
  skillId: string,
  database: Database = db,
): Promise<string | null> {
  const rows = await database
    .select({ name: agentSkills.name })
    .from(agentSkills)
    .where(eq(agentSkills.id, skillId))
    .limit(1);
  return rows[0]?.name ?? null;
}

export async function getShowdownById(
  showdownId: string,
  database: Database = db,
) {
  const rows = await database
    .select()
    .from(showdowns)
    .where(eq(showdowns.id, showdownId))
    .limit(1);
  return rows[0] ?? null;
}

export async function getShowdownByIssueId(
  issueId: string,
  database: Database = db,
) {
  const rows = await database
    .select()
    .from(showdowns)
    .where(eq(showdowns.issueId, issueId))
    .orderBy(showdowns.createdAt)
    .limit(1);
  return rows[0] ?? null;
}

export async function getShowdownWorkspaces(
  showdownId: string,
  database: Database = db,
) {
  return database
    .select({
      id: workspaces.id,
      branch: workspaces.branch,
      status: workspaces.status,
      showdownLabel: workspaces.showdownLabel,
      skillId: workspaces.skillId,
      model: workspaces.model,
      diffStatCacheFilesChanged: workspaces.diffStatCacheFilesChanged,
      diffStatCacheInsertions: workspaces.diffStatCacheInsertions,
      diffStatCacheDeletions: workspaces.diffStatCacheDeletions,
    })
    .from(workspaces)
    .where(eq(workspaces.showdownId, showdownId));
}

export async function getAgentSkillNamesByIds(
  skillIds: string[],
  database: Database = db,
) {
  return database
    .select({ id: agentSkills.id, name: agentSkills.name })
    .from(agentSkills)
    .where(inArray(agentSkills.id, skillIds));
}

export async function getShowdownWorkspaceMembership(
  workspaceId: string,
  database: Database = db,
) {
  const rows = await database
    .select({ id: workspaces.id, showdownId: workspaces.showdownId, issueId: workspaces.issueId })
    .from(workspaces)
    .where(eq(workspaces.id, workspaceId))
    .limit(1);
  return rows[0] ?? null;
}

export async function setShowdownWinner(
  showdownId: string,
  winnerWorkspaceId: string,
  updatedAt: string,
  database: Database = db,
): Promise<void> {
  await database.update(showdowns).set({
    status: "decided",
    winnerWorkspaceId,
    updatedAt,
  }).where(eq(showdowns.id, showdownId));
}

export async function getShowdownWorkspaceIds(
  showdownId: string,
  database: Database = db,
) {
  return database
    .select({ id: workspaces.id })
    .from(workspaces)
    .where(eq(workspaces.showdownId, showdownId));
}

export async function getIssueProjectId(
  issueId: string,
  database: Database = db,
) {
  const rows = await database
    .select({ projectId: issues.projectId })
    .from(issues)
    .where(eq(issues.id, issueId))
    .limit(1);
  return rows[0] ?? null;
}
