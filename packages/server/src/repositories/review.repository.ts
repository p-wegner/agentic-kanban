import { agentSkills, issues, preferences, sessions } from "@agentic-kanban/shared/schema";
import { and, desc, eq, sql } from "drizzle-orm";
import { db } from "../db/index.js";
import type { Database } from "../db/index.js";

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

// #502: one definition, in workspace-reads. This copy returned the raw ROW ARRAY, so
// its caller checked `.length === 0` to mean "not found".
export { getWorkspaceById } from "./workspace-reads.repository.js";

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

// #502: one definition, in project.repository. This copy wrapped the row in an ARRAY,
// so its caller had to unpack a list that never had more than one element.
export { getProjectDefaultBranch } from "./project.repository.js";
