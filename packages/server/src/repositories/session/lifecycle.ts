import { sessions, agentSkills, workspaces, issues, projects } from "@agentic-kanban/shared/schema";
import { eq, desc } from "drizzle-orm";
import { db } from "../../db/index.js";
import type { Database } from "../../db/index.js";

/** Clear a session's stored provider session id (#26 missing-transcript fallback). */
export async function clearSessionProviderSessionId(
  sessionId: string,
  database: Database = db,
): Promise<void> {
  await database.update(sessions).set({ providerSessionId: null }).where(eq(sessions.id, sessionId));
}

export async function getSessionWorkspaceId(
  sessionId: string,
  database: Database = db,
): Promise<string | null> {
  const rows = await database
    .select({ workspaceId: sessions.workspaceId })
    .from(sessions)
    .where(eq(sessions.id, sessionId))
    .limit(1);
  return rows[0]?.workspaceId ?? null;
}

export async function findRunningSession(
  workspaceId: string,
  database: Database = db,
) {
  const rows = await database
    .select()
    .from(sessions)
    .where(eq(sessions.workspaceId, workspaceId));
  return rows.find(s => s.status === "running") ?? null;
}

export async function findResumableSession(
  workspaceId: string,
  database: Database = db,
) {
  const allSessions = await database
    .select()
    .from(sessions)
    .where(eq(sessions.workspaceId, workspaceId));

  const running = allSessions.find(s => s.status === "running");
  if (running) return { session: running, stale: false };

  const completed = allSessions
    .filter(s => s.status === "completed" || s.status === "stopped")
    .sort((a, b) => (b.startedAt ?? "").localeCompare(a.startedAt ?? ""))[0];

  if (completed) return { session: completed, stale: true };

  return null;
}

export async function getWorkspaceSessions(
  workspaceId: string,
  database: Database = db,
) {
  return database
    .select()
    .from(sessions)
    .where(eq(sessions.workspaceId, workspaceId));
}

export async function getWorkspaceSkillName(
  skillId: string | null,
  database: Database = db,
): Promise<string | null> {
  if (!skillId) return null;
  const rows = await database
    .select({ name: agentSkills.name })
    .from(agentSkills)
    .where(eq(agentSkills.id, skillId))
    .limit(1);
  return rows[0]?.name ?? null;
}

/** A full session row by id, or null. (CLI `session analyze` / `session stats`.) */
export async function getSessionById(sessionId: string, database: Database = db) {
  const rows = await database.select().from(sessions).where(eq(sessions.id, sessionId)).limit(1);
  return rows[0] ?? null;
}

/** Full session metadata for the transcript view: session + workspace + issue + project. */
export async function getSessionTranscriptContext(sessionId: string, database: Database = db) {
  const rows = await database
    .select({
      sessionId: sessions.id,
      providerSessionId: sessions.providerSessionId,
      executor: sessions.executor,
      sessionStatus: sessions.status,
      startedAt: sessions.startedAt,
      endedAt: sessions.endedAt,
      exitCode: sessions.exitCode,
      triggerType: sessions.triggerType,
      skillId: sessions.skillId,
      skillName: sessions.skillName,
      workspaceId: workspaces.id,
      branch: workspaces.branch,
      workspaceStatus: workspaces.status,
      issueId: issues.id,
      issueNumber: issues.issueNumber,
      issueTitle: issues.title,
      projectId: projects.id,
      projectName: projects.name,
    })
    .from(sessions)
    .innerJoin(workspaces, eq(sessions.workspaceId, workspaces.id))
    .innerJoin(issues, eq(workspaces.issueId, issues.id))
    .innerJoin(projects, eq(issues.projectId, projects.id))
    .where(eq(sessions.id, sessionId))
    .limit(1);
  return rows[0] ?? null;
}

/** The id of the most recently started session for a workspace, or null. */
export async function getLatestSessionIdForWorkspace(
  workspaceId: string,
  database: Database = db,
): Promise<string | null> {
  const rows = await database
    .select({ id: sessions.id })
    .from(sessions)
    .where(eq(sessions.workspaceId, workspaceId))
    .orderBy(desc(sessions.startedAt))
    .limit(1);
  return rows[0]?.id ?? null;
}
