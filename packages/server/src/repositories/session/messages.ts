import { sessionMessages, sessions, workspaces, issues, projects, projectStatuses } from "@agentic-kanban/shared/schema";
import { eq, ne, and, sql, desc, inArray } from "drizzle-orm";
import { db } from "../../db/index.js";
import type { Database } from "../../db/index.js";
import type { AgentOutputMessage } from "@agentic-kanban/shared";
import { readSessionStdoutFile } from "../../lib/session-output-reader.js";
import {
  readSessionStdoutFileAsync,
  readSessionStdoutFileTailAsync,
  statSessionStdoutFile,
} from "@agentic-kanban/shared/lib/session-files";

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
 * Async twin of readStdoutFromFile (./stdout-file.ts): reconstruct stdout
 * message rows from the per-session .out file without ever blocking the event
 * loop on a multi-MB readFileSync. When `tailBytes` is given, only the last
 * `tailBytes` of the file are read (complete JSONL lines only — the tail
 * reader drops a truncated first line), which is what the polled transcript
 * panel actually renders.
 */
export async function readStdoutFromFileAsync(
  sessionId: string,
  tailBytes?: number,
): Promise<AgentOutputMessage[]> {
  const content =
    tailBytes !== undefined && tailBytes > 0
      ? await readSessionStdoutFileTailAsync(sessionId, tailBytes)
      : await readSessionStdoutFileAsync(sessionId);
  if (!content) return [];
  return [{ type: "stdout", sessionId, data: content }];
}

/**
 * Cheap change-detection metadata for a session's output: .out file size+mtime
 * plus the max session_messages id (one indexed MAX() lookup). Reads NO file
 * content and NO message rows — the /output route derives its ETag from this
 * BEFORE any transcript read, so a matching If-None-Match costs two tiny
 * queries and one fstat. Returns null when the session does not exist.
 */
export interface SessionOutputMeta {
  /** -1 when the .out file is absent. */
  fileSize: number;
  /** -1 when the .out file is absent. */
  fileMtimeMs: number;
  /** 0 when the session has no persisted messages. */
  maxMessageId: number;
}

export async function getSessionOutputMeta(
  sessionId: string,
  database: Database = db,
): Promise<SessionOutputMeta | null> {
  const sessionRows = await database
    .select({ id: sessions.id })
    .from(sessions)
    .where(eq(sessions.id, sessionId))
    .limit(1);
  if (sessionRows.length === 0) return null;

  const fileStat = await statSessionStdoutFile(sessionId);
  const maxRows = await database
    .select({ maxId: sql<number | null>`max(${sessionMessages.id})` })
    .from(sessionMessages)
    .where(eq(sessionMessages.sessionId, sessionId));

  return {
    fileSize: fileStat?.size ?? -1,
    fileMtimeMs: fileStat?.mtimeMs ?? -1,
    maxMessageId: maxRows[0]?.maxId ?? 0,
  };
}

/**
 * Upper bound on the DB-fallback read for historical sessions without a .out
 * file. Active sessions are ring-buffer-capped at 2000 rows (#404), so this
 * only trims pathological pre-cap sessions instead of streaming them whole.
 */
const DB_FALLBACK_MAX_ROWS = 5000;

export async function getSessionOutput(
  sessionId: string,
  database: Database = db,
  options?: { tailBytes?: number },
): Promise<{ messages: AgentOutputMessage[] } | null> {
  const sessionRows = await database
    .select({ id: sessions.id })
    .from(sessions)
    .where(eq(sessions.id, sessionId))
    .limit(1);
  if (sessionRows.length === 0) return null;

  // Stdout is served from the per-session .out file. Non-stdout messages
  // (exit, stderr) remain in the DB. For historical sessions whose .out
  // file is gone, fall back to DB rows.
  const stdoutMessages = await readStdoutFromFileAsync(sessionId, options?.tailBytes);

  let nonStdoutRows: AgentOutputMessage[] = [];
  if (stdoutMessages.length > 0) {
    // File present: only fetch non-stdout rows from DB (filtered in SQL, slim columns)
    const rows = await database
      .select({
        type: sessionMessages.type,
        sessionId: sessionMessages.sessionId,
        data: sessionMessages.data,
        exitCode: sessionMessages.exitCode,
      })
      .from(sessionMessages)
      .where(and(eq(sessionMessages.sessionId, sessionId), ne(sessionMessages.type, "stdout")))
      .orderBy(sessionMessages.id);
    nonStdoutRows = rows.map((row) => ({
      type: row.type as AgentOutputMessage["type"],
      sessionId: row.sessionId,
      data: row.data ?? undefined,
      exitCode: row.exitCode != null ? Number(row.exitCode) : undefined,
    }));
  } else {
    // No file (old session or cleaned up): read rows from DB — newest
    // DB_FALLBACK_MAX_ROWS only, returned in ascending order.
    const rows = await database
      .select({
        type: sessionMessages.type,
        sessionId: sessionMessages.sessionId,
        data: sessionMessages.data,
        exitCode: sessionMessages.exitCode,
      })
      .from(sessionMessages)
      .where(eq(sessionMessages.sessionId, sessionId))
      .orderBy(desc(sessionMessages.id))
      .limit(DB_FALLBACK_MAX_ROWS);
    rows.reverse();
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
