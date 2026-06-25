import { agentSkills, issues, preferences, sessions, workspaces } from "@agentic-kanban/shared/schema";
import { and, desc, eq, sql } from "drizzle-orm";
import { db } from "../db/index.js";
import type { Database } from "../db/index.js";
import { getProjectById } from "./project.repository.js";

export async function getProjectScopedReviewSkill(
  skillName: string,
  projectId: string,
  database: Database = db,
) {
  const rows = await database.select({ prompt: agentSkills.prompt, model: agentSkills.model }).from(agentSkills)
    .where(sql`${agentSkills.name} = ${skillName} AND (${agentSkills.projectId} = ${projectId} OR ${agentSkills.projectId} IS NULL)`)
    .orderBy(desc(agentSkills.projectId))
    .limit(1);
  return rows[0] ?? null;
}

export async function getGlobalReviewSkill(
  skillName: string,
  database: Database = db,
) {
  const rows = await database.select({ prompt: agentSkills.prompt, model: agentSkills.model }).from(agentSkills)
    .where(sql`${agentSkills.name} = ${skillName} AND ${agentSkills.projectId} IS NULL`)
    .limit(1);
  return rows[0] ?? null;
}

export async function getMonitorNudgeSkill(
  projectId: string,
  database: Database = db,
) {
  const rows = await database
    .select({ prompt: agentSkills.prompt })
    .from(agentSkills)
    .where(sql`
      ${agentSkills.name} = 'monitor-nudge'
      AND (${agentSkills.projectId} = ${projectId} OR ${agentSkills.projectId} IS NULL)
    `)
    .orderBy(sql`${agentSkills.projectId} IS NULL`)
    .limit(1);
  return rows[0] ?? null;
}

export async function getWorkspaceById(
  workspaceId: string,
  database: Database = db,
) {
  return database.select().from(workspaces).where(eq(workspaces.id, workspaceId)).limit(1);
}

export async function getRunningReviewSession(
  workspaceId: string,
  database: Database = db,
) {
  return database
    .select({ id: sessions.id })
    .from(sessions)
    .where(and(eq(sessions.workspaceId, workspaceId), eq(sessions.status, "running"), eq(sessions.triggerType, "review")))
    .limit(1);
}

export async function getRunningWorkspaceSession(
  workspaceId: string,
  database: Database = db,
) {
  return database
    .select({ id: sessions.id, triggerType: sessions.triggerType })
    .from(sessions)
    .where(and(eq(sessions.workspaceId, workspaceId), eq(sessions.status, "running")))
    .limit(1);
}

export async function getLatestWorkspaceSession(
  workspaceId: string,
  database: Database = db,
) {
  return database
    .select({
      id: sessions.id,
      status: sessions.status,
      triggerType: sessions.triggerType,
      stats: sessions.stats,
      endedAt: sessions.endedAt,
    })
    .from(sessions)
    .where(eq(sessions.workspaceId, workspaceId))
    .orderBy(desc(sessions.startedAt))
    .limit(1);
}

export async function getIssueProjectAndId(
  issueId: string,
  database: Database = db,
) {
  return database.select({ projectId: issues.projectId, id: issues.id }).from(issues).where(eq(issues.id, issueId)).limit(1);
}

export async function getAllPreferenceRows(
  database: Database = db,
) {
  return database.select().from(preferences);
}

export async function getProjectDefaultBranch(
  projectId: string,
  database: Database = db,
) {
  const project = await getProjectById(projectId, database);
  return project ? [{ defaultBranch: project.defaultBranch }] : [];
}

export async function setWorkspaceStatus(
  workspaceId: string,
  status: string,
  updatedAt: string,
  database: Database = db,
): Promise<void> {
  await database.update(workspaces).set({ status, updatedAt }).where(eq(workspaces.id, workspaceId));
}
