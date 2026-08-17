/**
 * "Prefer the on-disk .out file for stdout, else fall back to `session_messages`" —
 * the two-source rule, once (#507).
 *
 * Detached agents stream stdout to `os.tmpdir()/kanban-session-<id>.out`; historical
 * sessions (and any session whose file has been reaped) only have DB rows. Every reader
 * has to know that, and the rule was re-implemented at each one — so a change like the
 * bounded tail (`readSessionStdoutFileTail`, already in `session-files.ts`) reaches only
 * the readers someone remembers to update.
 *
 * SCOPE — this is narrower than "11 forks" suggests, and the difference matters. Only
 * FOUR call sites actually fetch message ROWS: the server repository's
 * `getSessionMessageRows`, the shared `loadIssueSummary`, and the MCP
 * `get_session_transcript` / `read_terminal` tools. The others named on the ticket
 * (`board-status-enrichment`, `test-run`, `workflow-fork`, `workspace-risk`,
 * `workspace-timeline`, `get_board_status`) branch on the same rule but then do
 * genuinely DIFFERENT things per branch — extract a last agent message, tail 1500 chars
 * of the whole file vs. the last row, build a per-session string map. They are not
 * copies of this function and folding them in would mean inventing a shared shape none
 * of them wants. They keep their own branch; only the fetch is unified here.
 */
import { eq, desc, count } from "drizzle-orm";
import * as schema from "../schema/index.js";
import type { WorkflowDb } from "./workflow-engine/types.js";
import { readSessionStdoutFile } from "./session-files.js";

/**
 * A message row. `exitCode` is TEXT in the schema (`text("exit_code")`), so it is
 * `string | null` here — callers that want a number convert at the edge, as the
 * `read_terminal` tool does.
 */
export interface SessionMessageRow {
  id?: number;
  type: string;
  data: string | null;
  exitCode?: string | null;
  createdAt?: string | null;
}

export interface ReadSessionMessagesResult {
  messages: SessionMessageRow[];
  /**
   * How many messages exist BEFORE `limit` was applied. `read_terminal` reports this to
   * the agent, so a helper that only returned the limited page would silently break it —
   * which is why this is not just `SessionMessageRow[]`.
   */
  total: number;
}

export interface ReadSessionMessagesOptions {
  /** Return only the newest N messages (still in chronological order). */
  limit?: number;
}

const COLUMNS = {
  id: schema.sessionMessages.id,
  type: schema.sessionMessages.type,
  data: schema.sessionMessages.data,
  exitCode: schema.sessionMessages.exitCode,
  createdAt: schema.sessionMessages.createdAt,
};

/**
 * Read a session's messages in chronological order, preferring the .out file for stdout.
 *
 * When the file exists it supplies a single synthetic `stdout` row and the DB supplies
 * only the non-stdout rows (exit, stderr) — merging rather than dropping them, because
 * the exit row is what tells a reader how the session ended. When it does not, every row
 * comes from the DB.
 *
 * With `limit`, the DB path pages in SQL (`desc` + `limit`, re-reversed) instead of
 * loading a whole transcript to throw most of it away; `total` then comes from a separate
 * `count()`. The file path has to merge before it can slice, so it counts what it built.
 */
export async function readSessionMessages(
  db: WorkflowDb,
  sessionId: string,
  opts: ReadSessionMessagesOptions = {},
): Promise<ReadSessionMessagesResult> {
  const limit = opts.limit !== undefined && opts.limit > 0 ? Math.floor(opts.limit) : undefined;
  const fileContent = readSessionStdoutFile(sessionId);

  if (fileContent !== null) {
    const rows = await db
      .select(COLUMNS)
      .from(schema.sessionMessages)
      .where(eq(schema.sessionMessages.sessionId, sessionId))
      .orderBy(schema.sessionMessages.id);
    const merged: SessionMessageRow[] = [
      { type: "stdout", data: fileContent },
      ...rows.filter((r) => r.type !== "stdout"),
    ];
    return {
      messages: limit === undefined ? merged : merged.slice(-limit),
      total: merged.length,
    };
  }

  if (limit === undefined) {
    const rows = await db
      .select(COLUMNS)
      .from(schema.sessionMessages)
      .where(eq(schema.sessionMessages.sessionId, sessionId))
      .orderBy(schema.sessionMessages.id);
    return { messages: rows, total: rows.length };
  }

  const [newest, totalRows] = await Promise.all([
    db
      .select(COLUMNS)
      .from(schema.sessionMessages)
      .where(eq(schema.sessionMessages.sessionId, sessionId))
      .orderBy(desc(schema.sessionMessages.id))
      .limit(limit),
    db
      .select({ n: count() })
      .from(schema.sessionMessages)
      .where(eq(schema.sessionMessages.sessionId, sessionId)),
  ]);
  return { messages: newest.reverse(), total: totalRows[0]?.n ?? newest.length };
}
