import { sessions, sessionMessages, workspaces, issues, preferences, agentSkills } from "@agentic-kanban/shared/schema";
import { sanitizeUtf8 } from "@agentic-kanban/shared/lib/sanitize-utf8";
import { setWorkspaceStatus, type WorkspaceStatus } from "@agentic-kanban/shared/lib/workspace-status";
import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import type { Database } from "../db/index.js";
import { getProjectById } from "./project.repository.js";
import { getSessionStatsRaw, getSessionStatus as getSessionStatusCanonical } from "./session.repository.js";

export async function getWorkspaceById(
  workspaceId: string,
  database: Database = db,
) {
  const rows = await database.select().from(workspaces).where(eq(workspaces.id, workspaceId)).limit(1);
  return rows[0] ?? null;
}

export async function getIssueProjectId(
  issueId: string,
  database: Database = db,
): Promise<string | null> {
  const rows = await database
    .select({ projectId: issues.projectId })
    .from(issues)
    .where(eq(issues.id, issueId))
    .limit(1);
  return rows.length > 0 ? rows[0].projectId : null;
}

export async function getProjectPreflightInfo(
  projectId: string,
  database: Database = db,
) {
  const project = await getProjectById(projectId, database);
  return project
    ? { repoPath: project.repoPath, defaultBranch: project.defaultBranch, symlinkEnabled: project.symlinkEnabled, symlinkDirs: project.symlinkDirs }
    : null;
}

export async function getPrevSessionResumeInfo(
  resumeFromId: string,
  database: Database = db,
) {
  const rows = await database
    .select({ providerSessionId: sessions.providerSessionId, executor: sessions.executor })
    .from(sessions)
    .where(eq(sessions.id, resumeFromId))
    .limit(1);
  return rows[0] ?? null;
}

/**
 * Clear a session's stored provider session id (#26 missing-transcript fallback) so a
 * future resume off this row can't keep forwarding a dead `--resume <id>`.
 */
export async function clearProviderSessionId(
  sessionId: string,
  database: Database = db,
): Promise<void> {
  await database.update(sessions).set({ providerSessionId: null }).where(eq(sessions.id, sessionId));
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

export async function getPreferenceValue(
  key: string,
  database: Database = db,
): Promise<string | undefined> {
  const rows = await database
    .select({ value: preferences.value })
    .from(preferences)
    .where(eq(preferences.key, key))
    .limit(1);
  if (rows.length === 0) return undefined;
  return rows[0].value;
}

export async function getSkipPermissionsRows(
  database: Database = db,
) {
  return database.select().from(preferences).where(eq(preferences.key, "skip_permissions")).limit(1);
}

export async function getAllPreferences(
  database: Database = db,
) {
  return database.select().from(preferences);
}

export async function getSessionStats(
  sessionId: string,
  database: Database = db,
): Promise<string | null | undefined> {
  return getSessionStatsRaw(sessionId, database);
}

export async function insertSession(
  values: {
    id: string;
    workspaceId: string;
    executor: string;
    status: string;
    startedAt: string;
    endedAt: string | null;
    resumeFromId: string | null;
    triggerType: string | null;
    skillId: string | null;
    skillName: string | null;
    stats: string;
  },
  database: Database = db,
): Promise<void> {
  await database.insert(sessions).values({ ...values, stats: sanitizeUtf8(values.stats) });
}

export async function updateSessionPid(
  sessionId: string,
  pid: number,
  database: Database = db,
) {
  return database
    .update(sessions)
    .set({ pid })
    .where(eq(sessions.id, sessionId));
}

export async function updateSessionStoppedNoStats(
  sessionId: string,
  endedAt: string,
  database: Database = db,
) {
  return database
    .update(sessions)
    .set({ status: "stopped", endedAt })
    .where(eq(sessions.id, sessionId));
}

export async function updateSessionStoppedWithStats(
  sessionId: string,
  endedAt: string,
  // `null` when the real exit code was never observed (external/reattach PID poll) — stored as
  // SQL NULL, never fabricated as "0", so an indeterminate exit is not mistaken for a clean one.
  exitCode: string | null,
  stats: string,
  database: Database = db,
): Promise<void> {
  await database.update(sessions)
    .set({ status: "stopped", endedAt, exitCode, stats: sanitizeUtf8(stats) })
    .where(eq(sessions.id, sessionId));
}

export async function updateWorkspaceStatus(
  workspaceId: string,
  status: string,
  updatedAt: string,
  database: Database = db,
): Promise<void> {
  await setWorkspaceStatus(database, workspaceId, status as WorkspaceStatus, { now: updatedAt });
}

export async function insertSessionMessage(
  values: { sessionId: string; type: string; data: string | null; exitCode: string | null },
  database: Database = db,
): Promise<void> {
  await database.insert(sessionMessages).values({
    ...values,
    data: values.data == null ? null : sanitizeUtf8(values.data),
  });
}

export async function updateSessionCompleted(
  sessionId: string,
  endedAt: string,
  exitCode: string,
  database: Database = db,
): Promise<void> {
  await database.update(sessions)
    .set({ status: "completed", endedAt, exitCode })
    .where(eq(sessions.id, sessionId));
}

export async function updateWorkspacePlanMode(
  workspaceId: string,
  planMode: boolean,
  updatedAt: string,
  database: Database = db,
): Promise<void> {
  await database.update(workspaces).set({ planMode, updatedAt }).where(eq(workspaces.id, workspaceId));
}

export async function updateWorkspaceStatusOnly(
  workspaceId: string,
  status: string,
  updatedAt: string,
  database: Database = db,
): Promise<void> {
  await setWorkspaceStatus(database, workspaceId, status as WorkspaceStatus, { now: updatedAt });
}

export async function updateWorkspacePendingPlan(
  workspaceId: string,
  pendingPlanPath: string,
  status: string,
  updatedAt: string,
  database: Database = db,
): Promise<void> {
  await setWorkspaceStatus(database, workspaceId, status as WorkspaceStatus, {
    now: updatedAt,
    set: { pendingPlanPath },
  });
}

export async function getSessionStatus(
  sessionId: string,
  database: Database = db,
) {
  const status = await getSessionStatusCanonical(sessionId, database);
  if (status === null) return null;
  // startedAt/executor are needed by the external-exit classifier (durationMs for the
  // launch-failure window + provider for usage-limit detection); one query keeps the
  // repository surface flat (no extra function — the god-module gate is at its ceiling).
  const rows = await database
    .select({ startedAt: sessions.startedAt, executor: sessions.executor })
    .from(sessions)
    .where(eq(sessions.id, sessionId))
    .limit(1);
  return { status, startedAt: rows[0]?.startedAt ?? null, executor: rows[0]?.executor ?? null };
}

export async function getSessionWorkspaceId(
  sessionId: string,
  database: Database = db,
) {
  const rows = await database.select({ workspaceId: sessions.workspaceId })
    .from(sessions)
    .where(eq(sessions.id, sessionId))
    .limit(1);
  return rows[0] ?? null;
}
