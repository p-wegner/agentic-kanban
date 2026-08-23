import { sessions, sessionMessages, workspaces, preferences } from "@agentic-kanban/shared/schema";
import { sanitizeUtf8 } from "@agentic-kanban/shared/lib/sanitize-utf8";
import { setWorkspaceStatus, type WorkspaceStatus } from "@agentic-kanban/shared/lib/workspace-status";
import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import type { Database } from "../db/index.js";
import { getProjectById } from "./project.repository.js";
import { getAllPreferences as canonicalGetAllPreferences } from "./preferences.repository.js";
import { getPreference as canonicalGetPreference } from "./preferences.repository.js";
import {
  clearSessionProviderSessionId,
  getSessionStatsRaw,
  getSessionStatus as getSessionStatusCanonical,
  getSessionWorkspaceId as getSessionWorkspaceIdCanonical,
} from "./session.repository.js";
import { firstRow } from "@agentic-kanban/shared/lib/first-row";

// #502: one definition, in workspace-reads (this copy already had its shape, untyped).
export { getWorkspaceById } from "./workspace-reads.repository.js";

// #502: one definition, in issue.repository (this copy was the same query with
// `rows.length > 0 ? ... : null` instead of `?? null`).
export { getIssueProjectId } from "./issue.repository.js";

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
  return firstRow(
    database
      .select({ providerSessionId: sessions.providerSessionId, executor: sessions.executor })
      .from(sessions)
      .where(eq(sessions.id, resumeFromId))
      .limit(1)
  );
}

/**
 * Clear a session's stored provider session id (#26 missing-transcript fallback) so a
 * future resume off this row can't keep forwarding a dead `--resume <id>`.
 */
export async function clearProviderSessionId(
  sessionId: string,
  database: Database = db,
): Promise<void> {
  await clearSessionProviderSessionId(sessionId, database);
}

/** #613: delegates to the canonical reader (which records the db:getPreference metric). */
export async function getPreferenceValue(key: string, database: Database = db): Promise<string | undefined> {
  // `?? undefined` is NOT cosmetic: this clone's callers were typed against
  // `string | undefined` while the canonical reader returns `string | null`. Three clones
  // had three different contracts (#613) — each is preserved exactly, so this commit
  // removes the duplicated QUERY without changing any caller's types.
  return (await canonicalGetPreference(key, database)) ?? undefined;
}

export async function getSkipPermissionsRows(
  database: Database = db,
) {
  return database.select().from(preferences).where(eq(preferences.key, "skip_permissions")).limit(1);
}

/** #613: delegates to the canonical reader — see preferences.repository. */
export async function getAllPreferences(database: Database = db) {
  return canonicalGetAllPreferences(database);
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

/**
 * Persist the devcontainer this session's agent runs inside (#154), so a
 * later stop/hang-kill/killAll — or a post-restart reattach — can reach the
 * in-container process instead of only the host docker-exec client.
 */
export async function updateSessionContainerId(
  sessionId: string,
  containerId: string,
  database: Database = db,
): Promise<void> {
  await database
    .update(sessions)
    .set({ containerId })
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
  const workspaceId = await getSessionWorkspaceIdCanonical(sessionId, database);
  return workspaceId === null ? null : { workspaceId };
}
