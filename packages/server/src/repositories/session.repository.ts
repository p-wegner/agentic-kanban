import { sessions, sessionMessages, diffComments, agentSkills, workspaces, issues, projects, projectStatuses } from "@agentic-kanban/shared/schema";
import { eq, and, sql, desc } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { readFileSync, existsSync, openSync, readSync, closeSync, fstatSync } from "node:fs";
import { db } from "../db/index.js";
import type { Database } from "../db/index.js";
import type { AgentOutputMessage, SessionSummary } from "@agentic-kanban/shared";
import { sessionOutputPath } from "../services/agent.service.js";

/**
 * Read stdout content from the per-session .out file, or null when absent.
 */
export function readSessionStdoutFile(sessionId: string): string | null {
  const outPath = sessionOutputPath(sessionId);
  if (!existsSync(outPath)) return null;
  try {
    const content = readFileSync(outPath, "utf-8");
    return content || null;
  } catch {
    return null;
  }
}

/**
 * Read at most the last `maxBytes` bytes of the per-session .out file, or null
 * when the file is absent or empty. Bounded alternative to readSessionStdoutFile
 * for hot polling paths (agent-questions): the terminal `result` event is one of
 * the LAST JSONL lines, so the tail is sufficient — reading whole multi-MB
 * transcripts synchronously blocked the event loop for 150ms+ per poll.
 * When the read is truncated, the (likely partial) first line of the window is
 * dropped so callers only ever see complete JSONL lines.
 */
export function readSessionStdoutFileTail(
  sessionId: string,
  maxBytes = 256 * 1024,
): string | null {
  const outPath = sessionOutputPath(sessionId);
  let fd: number;
  try {
    fd = openSync(outPath, "r");
  } catch {
    return null; // absent (or unreadable) — caller falls back to DB rows
  }
  try {
    const size = fstatSync(fd).size;
    if (size === 0) return null;
    const start = Math.max(0, size - maxBytes);
    const length = size - start;
    const buf = Buffer.alloc(length);
    const bytesRead = readSync(fd, buf, 0, length, start);
    let content = buf.toString("utf-8", 0, bytesRead);
    if (start > 0) {
      // Truncated mid-line: drop everything before the first newline.
      const nl = content.indexOf("\n");
      content = nl === -1 ? "" : content.slice(nl + 1);
    }
    return content || null;
  } catch {
    return null;
  } finally {
    closeSync(fd);
  }
}

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
    return { status: "found", stats: JSON.parse(statsStr) };
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
    try { stats = JSON.parse(session.stats); } catch { /* ignore */ }
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
  const { q, projectId, statusFilter, providerFilter, limit } = params;
  const conditions = [
    sql`${sessionMessages.data} IS NOT NULL`,
    sql`${sessionMessages.data} LIKE ${"%" + q + "%"}`,
    sql`${sessionMessages.type} != 'exit'`,
  ];
  if (projectId) conditions.push(eq(issues.projectId, projectId));
  if (statusFilter) conditions.push(eq(projectStatuses.name, statusFilter));
  if (providerFilter) conditions.push(eq(sessions.executor, providerFilter));

  return database
    .select({
      messageId: sessionMessages.id,
      messageData: sessionMessages.data,
      messageCreatedAt: sessionMessages.createdAt,
      sessionId: sessions.id,
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
