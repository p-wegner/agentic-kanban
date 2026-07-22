import { sessionMessages, sessions, workspaces, issues, projects, projectStatuses } from "@agentic-kanban/shared/schema";
import { eq, and, sql, desc, inArray } from "drizzle-orm";
import { db } from "../../db/index.js";
import type { Database } from "../../db/index.js";
import type { AgentOutputMessage } from "@agentic-kanban/shared";
import { readSessionStdoutFile } from "../../lib/session-output-reader.js";
import { readStdoutFromFile } from "./stdout-file.js";

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
