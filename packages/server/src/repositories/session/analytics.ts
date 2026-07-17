import { sessions, agentSkills, workspaces, issues } from "@agentic-kanban/shared/schema";
import { eq, and, desc, inArray, gte, isNotNull } from "drizzle-orm";
import { db } from "../../db/index.js";
import type { Database } from "../../db/index.js";

/**
 * Session rows backing the Insights panel: every session for a project (optionally
 * since `dateFromIso`), joined to its workspace/issue/skill for the per-skill,
 * per-model, per-provider, friction and time-series rollups the route computes.
 * Pure read; passing dateFromIso=null returns the whole-project history.
 */
export async function getInsightsSessionRows(
  projectId: string,
  dateFromIso: string | null,
  database: Database = db,
) {
  const whereClause = dateFromIso
    ? and(eq(issues.projectId, projectId), gte(sessions.startedAt, dateFromIso))
    : eq(issues.projectId, projectId);
  return database
    .select({
      sessionId: sessions.id,
      workspaceId: sessions.workspaceId,
      stats: sessions.stats,
      startedAt: sessions.startedAt,
      exitCode: sessions.exitCode,
      wsModel: workspaces.model,
      wsSkillId: workspaces.skillId,
      wsProvider: workspaces.provider,
      wsClaudeProfile: workspaces.claudeProfile,
      sessionSkillId: sessions.skillId,
      sessionSkillName: sessions.skillName,
      issueType: issues.issueType,
      issuePriority: issues.priority,
      issueTitle: issues.title,
      issueNumber: issues.issueNumber,
      issueId: issues.id,
      skillName: agentSkills.name,
    })
    .from(sessions)
    .innerJoin(workspaces, eq(sessions.workspaceId, workspaces.id))
    .innerJoin(issues, eq(workspaces.issueId, issues.id))
    .leftJoin(agentSkills, eq(workspaces.skillId, agentSkills.id))
    .where(whereClause);
}

/**
 * Sessions that started within the window for a set of workspaces — the columns
 * the standup digest rolls up (status/exitCode/stats/triggerType). Pure read.
 */
export async function getSessionsForWorkspacesSince(
  workspaceIds: string[],
  sinceIso: string,
  database: Database = db,
) {
  if (workspaceIds.length === 0) return [];
  return database
    .select({
      id: sessions.id,
      workspaceId: sessions.workspaceId,
      startedAt: sessions.startedAt,
      endedAt: sessions.endedAt,
      exitCode: sessions.exitCode,
      status: sessions.status,
      stats: sessions.stats,
      triggerType: sessions.triggerType,
    })
    .from(sessions)
    .where(and(inArray(sessions.workspaceId, workspaceIds), gte(sessions.startedAt, sinceIso)));
}

/** Most recent sessions across all workspaces, joined to workspace + issue context. */
export async function getRecentSessionsWithContext(limit: number, database: Database = db) {
  return database
    .select({
      sessionId: sessions.id,
      sessionStatus: sessions.status,
      startedAt: sessions.startedAt,
      endedAt: sessions.endedAt,
      executor: sessions.executor,
      triggerType: sessions.triggerType,
      workspaceId: workspaces.id,
      branch: workspaces.branch,
      wsStatus: workspaces.status,
      issueNumber: issues.issueNumber,
      issueTitle: issues.title,
    })
    .from(sessions)
    .innerJoin(workspaces, eq(sessions.workspaceId, workspaces.id))
    .innerJoin(issues, eq(workspaces.issueId, issues.id))
    .orderBy(desc(sessions.startedAt))
    .limit(limit);
}

/**
 * Ended sessions eligible for friction backfill: all of them, or only those
 * started since `sinceIso`. Returns id + stats (the backfill recomputes friction
 * from the session's stored messages).
 */
export async function getSessionsForFrictionBackfill(
  params: { includeAll: boolean; sinceIso?: string },
  database: Database = db,
) {
  const whereClause =
    params.includeAll || !params.sinceIso
      ? isNotNull(sessions.endedAt)
      : and(isNotNull(sessions.endedAt), gte(sessions.startedAt, params.sinceIso));
  return database
    .select({ id: sessions.id, stats: sessions.stats })
    .from(sessions)
    .where(whereClause);
}

/**
 * Sessions for a project since `sinceIso`, joined to workspace + issue, carrying
 * the git/merge columns the reviewer-fixes analysis attributes commits against.
 */
export async function getReviewerFixSessionRows(
  params: { projectId: string; sinceIso: string },
  database: Database = db,
) {
  return database
    .select({
      sessionId: sessions.id,
      triggerType: sessions.triggerType,
      executor: sessions.executor,
      startedAt: sessions.startedAt,
      endedAt: sessions.endedAt,
      workspaceId: workspaces.id,
      branch: workspaces.branch,
      wsStatus: workspaces.status,
      provider: workspaces.provider,
      baseCommitSha: workspaces.baseCommitSha,
      mergedHeadSha: workspaces.mergedHeadSha,
      mergedAt: workspaces.mergedAt,
      issueNumber: issues.issueNumber,
      issueTitle: issues.title,
    })
    .from(sessions)
    .innerJoin(workspaces, eq(sessions.workspaceId, workspaces.id))
    .innerJoin(issues, eq(workspaces.issueId, issues.id))
    .where(and(eq(issues.projectId, params.projectId), gte(sessions.startedAt, params.sinceIso)))
    .orderBy(sessions.startedAt);
}
