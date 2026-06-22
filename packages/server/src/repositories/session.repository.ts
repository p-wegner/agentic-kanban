import { sessions, sessionMessages, diffComments, agentSkills, workspaces, issues, projects, projectStatuses } from "@agentic-kanban/shared/schema";
import { eq, and, sql, desc, inArray, gte, isNotNull } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { db } from "../db/index.js";
import type { Database } from "../db/index.js";
import type { AgentOutputMessage, SessionSummary } from "@agentic-kanban/shared";
import { readSessionStdoutFile } from "../lib/session-output-reader.js";

// The per-session .out transcript readers (readSessionStdoutFile /
// readSessionStdoutFileTail) are a filesystem ADAPTER, not persistence — they
// live in lib/session-output-reader.ts so this repository stays pure DB access
// (enforced by the repositories-are-infra-pure lint:arch rule). Re-exported here
// for back-compat is intentionally avoided: callers import the adapter directly.

/**
 * Read stdout messages from the per-session .out file. Returns an array of
 * AgentOutputMessage rows (type="stdout") reconstructed from the raw chunks,
 * or an empty array when the file is absent (e.g. old sessions before this change).
 */
function readStdoutFromFile(sessionId: string): AgentOutputMessage[] {
  const content = readSessionStdoutFile(sessionId);
  if (!content) return [];
  return [{ type: "stdout", sessionId, data: content }];
}

/**
 * Load each session's output as message rows, preferring the on-disk .out file
 * (where detached agents stream stdout) and falling back to persisted
 * session_messages for historical sessions. The returned rows are ready to feed
 * to parseSessionSummary. Consolidates the file-or-DB loader that was duplicated
 * across the github-handoff and workspace-handoff-bundle services.
 */
export async function loadSessionMessageRowsWithFileFallback(
  sessionIds: string[],
  database: Database = db,
): Promise<Array<{ type: string; data: string | null; sessionId: string }>> {
  if (sessionIds.length === 0) return [];
  const rows: Array<{ type: string; data: string | null; sessionId: string }> = [];
  const needsDb: string[] = [];
  for (const sid of sessionIds) {
    const fileContent = readSessionStdoutFile(sid);
    if (fileContent !== null) {
      rows.push({ type: "stdout", data: fileContent, sessionId: sid });
    } else {
      needsDb.push(sid);
    }
  }
  if (needsDb.length > 0) {
    const dbRows = await database
      .select({ type: sessionMessages.type, data: sessionMessages.data, sessionId: sessionMessages.sessionId })
      .from(sessionMessages)
      .where(inArray(sessionMessages.sessionId, needsDb));
    rows.push(...dbRows);
  }
  return rows;
}

/**
 * Get session message rows for a single session, with .out file fallback for stdout.
 * When the .out file exists, stdout is served from it; non-stdout rows come from DB.
 * Falls back to DB-only for historical sessions without a .out file.
 * Returns rows in { type, data } shape for use with parseSessionSummary.
 */
export async function getSessionMessageRows(
  sessionId: string,
  database: Database = db,
): Promise<Array<{ type: string; data: string | null }>> {
  const fileContent = readSessionStdoutFile(sessionId);
  if (fileContent !== null) {
    // File present: stdout from file, non-stdout from DB
    const dbRows = await database
      .select({ type: sessionMessages.type, data: sessionMessages.data })
      .from(sessionMessages)
      .where(eq(sessionMessages.sessionId, sessionId))
      .orderBy(sessionMessages.id);
    const nonStdout = dbRows.filter((r) => r.type !== "stdout");
    return [{ type: "stdout", data: fileContent }, ...nonStdout];
  }
  // No file: historical session, read all from DB
  const dbRows = await database
    .select({ type: sessionMessages.type, data: sessionMessages.data })
    .from(sessionMessages)
    .where(eq(sessionMessages.sessionId, sessionId))
    .orderBy(sessionMessages.id);
  return dbRows;
}

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

export async function getDiffComments(
  workspaceId: string,
  filePath?: string,
  database: Database = db,
) {
  const conditions = [eq(diffComments.workspaceId, workspaceId)];
  if (filePath) {
    conditions.push(eq(diffComments.filePath, filePath));
  }
  return database
    .select()
    .from(diffComments)
    .where(and(...conditions));
}

export async function createDiffComment(
  workspaceId: string,
  body: { filePath: string; body: string; lineNumOld?: number | null; lineNumNew?: number | null; side?: string },
  database: Database = db,
) {
  const now = new Date().toISOString();
  const comment = {
    id: randomUUID(),
    workspaceId,
    filePath: body.filePath,
    lineNumOld: body.lineNumOld ?? null,
    lineNumNew: body.lineNumNew ?? null,
    side: body.side || "new",
    body: body.body,
    resolvedAt: null as string | null,
    createdAt: now,
    updatedAt: now,
  };

  await database.insert(diffComments).values(comment);
  return comment;
}

export async function setDiffCommentResolved(
  commentId: string,
  resolved: boolean,
  database: Database = db,
) {
  const now = new Date().toISOString();
  await database
    .update(diffComments)
    .set({ resolvedAt: resolved ? now : null, updatedAt: now })
    .where(eq(diffComments.id, commentId));
}

export async function updateDiffComment(
  commentId: string,
  body: string,
  database: Database = db,
) {
  const now = new Date().toISOString();
  await database
    .update(diffComments)
    .set({ body, updatedAt: now })
    .where(eq(diffComments.id, commentId));
}

export async function findDiffComment(
  commentId: string,
  workspaceId: string,
  database: Database = db,
) {
  const rows = await database
    .select()
    .from(diffComments)
    .where(and(eq(diffComments.id, commentId), eq(diffComments.workspaceId, workspaceId)))
    .limit(1);
  return rows[0] ?? null;
}

export async function deleteDiffComment(commentId: string, database: Database = db) {
  await database.delete(diffComments).where(eq(diffComments.id, commentId));
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

export async function getSessionOutput(
  sessionId: string,
  database: Database = db,
): Promise<{ messages: AgentOutputMessage[] } | null> {
  const sessionRows = await database
    .select()
    .from(sessions)
    .where(eq(sessions.id, sessionId))
    .limit(1);
  if (sessionRows.length === 0) return null;

  // Stdout is served from the per-session .out file. Non-stdout messages
  // (exit, stderr) remain in the DB. For historical sessions whose .out
  // file is gone, fall back to DB rows.
  const stdoutMessages = readStdoutFromFile(sessionId);

  let nonStdoutRows: AgentOutputMessage[] = [];
  if (stdoutMessages.length > 0) {
    // File present: only fetch non-stdout rows from DB
    const rows = await database
      .select()
      .from(sessionMessages)
      .where(eq(sessionMessages.sessionId, sessionId))
      .orderBy(sessionMessages.id);
    nonStdoutRows = rows
      .filter((r) => r.type !== "stdout")
      .map((row) => ({
        type: row.type as AgentOutputMessage["type"],
        sessionId: row.sessionId,
        data: row.data ?? undefined,
        exitCode: row.exitCode != null ? Number(row.exitCode) : undefined,
      }));
  } else {
    // No file (old session or cleaned up): read all rows from DB
    const rows = await database
      .select()
      .from(sessionMessages)
      .where(eq(sessionMessages.sessionId, sessionId))
      .orderBy(sessionMessages.id);
    nonStdoutRows = rows.map((row) => ({
      type: row.type as AgentOutputMessage["type"],
      sessionId: row.sessionId,
      data: row.data ?? undefined,
      exitCode: row.exitCode != null ? Number(row.exitCode) : undefined,
    }));
  }

  // Interleave: stdout first (the stream), then exit/stderr at the end
  const messages: AgentOutputMessage[] = [...stdoutMessages, ...nonStdoutRows];
  return { messages };
}

export type SessionStatsResult =
  | { status: "found"; stats: Record<string, unknown> }
  | { status: "not_found" }
  | { status: "no_stats" };

export async function getSessionStats(
  sessionId: string,
  database: Database = db,
): Promise<SessionStatsResult> {
  const sessionRows = await database
    .select({ stats: sessions.stats })
    .from(sessions)
    .where(eq(sessions.id, sessionId))
    .limit(1);
  if (sessionRows.length === 0) return { status: "not_found" };

  const statsStr = sessionRows[0].stats;
  if (!statsStr) return { status: "no_stats" };

  try {
    return { status: "found", stats: JSON.parse(statsStr) as Record<string, unknown> };
  } catch {
    throw new Error("Invalid stats data");
  }
}

export type SessionSummaryResult = SessionSummary & {
  sessionId: string;
  duration: string | null;
  stats: Record<string, unknown> | null;
  status: string | null;
  startedAt: string | null;
  endedAt: string | null;
};

export async function getSessionSummaryData(
  sessionId: string,
  database: Database = db,
): Promise<SessionSummaryResult | null> {
  const sessionRows = await database
    .select()
    .from(sessions)
    .where(eq(sessions.id, sessionId))
    .limit(1);
  if (sessionRows.length === 0) return null;

  const session = sessionRows[0];

  // Use stdout from .out file if available; fall back to DB for historical sessions
  const stdoutMessages = readStdoutFromFile(sessionId);
  let rows: Array<{ type: string; data: string | null }>;
  if (stdoutMessages.length > 0) {
    rows = stdoutMessages.map((m) => ({ type: m.type, data: m.data ?? null }));
  } else {
    const dbRows = await database
      .select()
      .from(sessionMessages)
      .where(eq(sessionMessages.sessionId, sessionId))
      .orderBy(sessionMessages.id);
    rows = dbRows.map((r) => ({ type: r.type, data: r.data }));
  }

  let stats: Record<string, unknown> | null = null;
  if (session.stats) {
    try { stats = JSON.parse(session.stats) as Record<string, unknown>; } catch { /* ignore */ }
  }

  let duration: string | null = null;
  if (session.endedAt && session.startedAt) {
    const diffMs = new Date(session.endedAt).getTime() - new Date(session.startedAt).getTime();
    const { formatDurationStr } = await import("@agentic-kanban/shared");
    duration = formatDurationStr(diffMs);
  }

  const { parseSessionSummary } = await import("@agentic-kanban/shared");
  const summary = parseSessionSummary(rows);

  if (!summary.agentSummary && stats && typeof stats.agentSummary === "string") {
    summary.agentSummary = stats.agentSummary;
  }

  return {
    sessionId,
    duration,
    stats,
    status: session.status,
    startedAt: session.startedAt,
    endedAt: session.endedAt,
    ...summary,
  };
}

export interface TranscriptSearchParams {
  q: string;
  projectId?: string;
  /** Restrict to a single issue by its per-project issue number (CLI `--issue`). */
  issueNumber?: number;
  statusFilter?: string;
  providerFilter?: string;
  limit: number;
}

/**
 * Full-text-ish transcript search across session messages, joined up to the issue
 * /project/status chain so the caller can present and filter results. Pure read;
 * the route owns snippet extraction + DTO shaping.
 */
export async function searchTranscriptMessages(
  params: TranscriptSearchParams,
  database: Database = db,
) {
  const { q, projectId, issueNumber, statusFilter, providerFilter, limit } = params;
  const conditions = [
    sql`${sessionMessages.data} IS NOT NULL`,
    sql`${sessionMessages.data} LIKE ${"%" + q + "%"}`,
    sql`${sessionMessages.type} != 'exit'`,
  ];
  if (projectId) conditions.push(eq(issues.projectId, projectId));
  if (typeof issueNumber === "number" && !Number.isNaN(issueNumber)) {
    conditions.push(eq(issues.issueNumber, issueNumber));
  }
  if (statusFilter) conditions.push(eq(projectStatuses.name, statusFilter));
  if (providerFilter) conditions.push(eq(sessions.executor, providerFilter));

  return database
    .select({
      messageId: sessionMessages.id,
      messageData: sessionMessages.data,
      messageCreatedAt: sessionMessages.createdAt,
      sessionId: sessions.id,
      providerSessionId: sessions.providerSessionId,
      sessionStartedAt: sessions.startedAt,
      sessionStatus: sessions.status,
      executor: sessions.executor,
      workspaceId: workspaces.id,
      branch: workspaces.branch,
      workspaceStatus: workspaces.status,
      projectId: projects.id,
      projectName: projects.name,
      issueId: issues.id,
      issueNumber: issues.issueNumber,
      issueTitle: issues.title,
      issueStatusName: projectStatuses.name,
    })
    .from(sessionMessages)
    .innerJoin(sessions, eq(sessionMessages.sessionId, sessions.id))
    .innerJoin(workspaces, eq(sessions.workspaceId, workspaces.id))
    .innerJoin(issues, eq(workspaces.issueId, issues.id))
    .innerJoin(projects, eq(issues.projectId, projects.id))
    .innerJoin(projectStatuses, eq(issues.statusId, projectStatuses.id))
    .where(and(...conditions))
    .orderBy(desc(sessionMessages.id))
    .limit(limit);
}

/** A full session row by id, or null. (CLI `session analyze` / `session stats`.) */
export async function getSessionById(sessionId: string, database: Database = db) {
  const rows = await database.select().from(sessions).where(eq(sessions.id, sessionId)).limit(1);
  return rows[0] ?? null;
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

/** Overwrite a session's serialized stats JSON. */
export async function updateSessionStats(
  sessionId: string,
  statsJson: string,
  database: Database = db,
) {
  await database.update(sessions).set({ stats: statsJson }).where(eq(sessions.id, sessionId));
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

/** The newest `limit` messages for a session (returned newest-first; caller reverses). */
export async function getNewestSessionMessages(
  sessionId: string,
  limit: number,
  database: Database = db,
) {
  return database
    .select({
      id: sessionMessages.id,
      type: sessionMessages.type,
      data: sessionMessages.data,
      exitCode: sessionMessages.exitCode,
      createdAt: sessionMessages.createdAt,
    })
    .from(sessionMessages)
    .where(eq(sessionMessages.sessionId, sessionId))
    .orderBy(desc(sessionMessages.id))
    .limit(limit);
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

/**
 * Full session-message rows for one session, NEWEST-first by id, DB-only (no
 * .out-file fallback). CLI `issue status` needs this exact order for
 * extractLastAgentMessageFromRows — do NOT swap for getSessionMessageRows.
 */
export async function getSessionMessagesByIdDesc(sessionId: string, database: Database = db) {
  return database
    .select()
    .from(sessionMessages)
    .where(eq(sessionMessages.sessionId, sessionId))
    .orderBy(desc(sessionMessages.id));
}

/**
 * Full session-message rows for one session, OLDEST-first by id, DB-only. CLI
 * `issue summary` feeds these to parseSessionSummary in ascending order.
 */
export async function getSessionMessagesByIdAsc(sessionId: string, database: Database = db) {
  return database
    .select()
    .from(sessionMessages)
    .where(eq(sessionMessages.sessionId, sessionId))
    .orderBy(sessionMessages.id);
}
