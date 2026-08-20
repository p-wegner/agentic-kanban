import { sessions, sessionMessages } from "@agentic-kanban/shared/schema";
import { eq } from "drizzle-orm";
import { db } from "../../db/index.js";
import type { Database } from "../../db/index.js";
import type { SessionSummary } from "@agentic-kanban/shared";
import { getSessionOutputMeta, readStdoutFromFileAsync } from "./messages.js";

/**
 * Canonical narrow status read (#957). Was duplicated in merge-helpers /
 * session-lifecycle per-consumer mirrors. Returns the status string, or null
 * when the session does not exist.
 */
export async function getSessionStatus(
  sessionId: string,
  database: Database = db,
): Promise<string | null> {
  const rows = await database
    .select({ status: sessions.status })
    .from(sessions)
    .where(eq(sessions.id, sessionId))
    .limit(1);
  return rows.length > 0 ? rows[0].status : null;
}

/**
 * Canonical raw stats read (#957) — the unparsed `sessions.stats` string.
 * `undefined` = session not found, `null` = session exists but has no stats.
 * (getSessionStats below is the parsed, discriminated-union variant.)
 */
export async function getSessionStatsRaw(
  sessionId: string,
  database: Database = db,
): Promise<string | null | undefined> {
  const rows = await database
    .select({ stats: sessions.stats })
    .from(sessions)
    .where(eq(sessions.id, sessionId))
    .limit(1);
  if (rows.length === 0) return undefined;
  return rows[0].stats;
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

/** Overwrite a session's serialized stats JSON. */
export async function updateSessionStats(
  sessionId: string,
  statsJson: string,
  database: Database = db,
) {
  await database.update(sessions).set({ stats: statsJson }).where(eq(sessions.id, sessionId));
}

export type SessionSummaryResult = SessionSummary & {
  sessionId: string;
  duration: string | null;
  stats: Record<string, unknown> | null;
  status: string | null;
  startedAt: string | null;
  endedAt: string | null;
};

// ---------------------------------------------------------------------------
// Summary parse memo (perf G2): /sessions/:id/summary is polled every ~4s per
// open transcript panel, and parseSessionSummary re-walked the whole multi-MB
// transcript on every poll. The parse result is memoized per session, keyed on
// the cheap output metadata (.out file size+mtime + max message id) — the same
// change signal the /output ETag uses — so an unchanged transcript costs one
// fstat + one indexed MAX() instead of a full read+parse. Small LRU: the
// number of concurrently-polled sessions is tiny.
// ---------------------------------------------------------------------------
const SUMMARY_MEMO_MAX_ENTRIES = 50;
const summaryMemo = new Map<string, { key: string; summary: SessionSummary }>();
let summaryMemoHits = 0;
let summaryMemoMisses = 0;

/** Test seam: reset the memo (and its hit/miss counters) between tests. */
export function clearSessionSummaryMemo(): void {
  summaryMemo.clear();
  summaryMemoHits = 0;
  summaryMemoMisses = 0;
}

/** Test seam: observe memo effectiveness without spying on the parser import. */
export function getSessionSummaryMemoStats(): { hits: number; misses: number; size: number } {
  return { hits: summaryMemoHits, misses: summaryMemoMisses, size: summaryMemo.size };
}

/**
 * Parse (or reuse) the transcript-derived summary for a session. Returns a
 * SHALLOW CLONE so the caller's agentSummary fold-in never mutates the cached
 * object.
 */
async function getParsedSummaryMemoized(
  sessionId: string,
  database: Database,
): Promise<SessionSummary> {
  const meta = await getSessionOutputMeta(sessionId, database);
  const key = meta ? `${meta.fileSize}:${Math.trunc(meta.fileMtimeMs)}:${meta.maxMessageId}` : "absent";

  const cached = summaryMemo.get(sessionId);
  if (cached && cached.key === key) {
    // LRU touch: re-insert so Map iteration order tracks recency.
    summaryMemo.delete(sessionId);
    summaryMemo.set(sessionId, cached);
    summaryMemoHits++;
    return { ...cached.summary };
  }
  summaryMemoMisses++;

  // Use stdout from .out file if available; fall back to DB for historical sessions
  const stdoutMessages = await readStdoutFromFileAsync(sessionId);
  let rows: Array<{ type: string; data: string | null }>;
  if (stdoutMessages.length > 0) {
    rows = stdoutMessages.map((m) => ({ type: m.type, data: m.data ?? null }));
  } else {
    const dbRows = await database
      .select({ type: sessionMessages.type, data: sessionMessages.data })
      .from(sessionMessages)
      .where(eq(sessionMessages.sessionId, sessionId))
      .orderBy(sessionMessages.id);
    rows = dbRows.map((r) => ({ type: r.type, data: r.data }));
  }

  const { parseSessionSummary } = await import("@agentic-kanban/shared");
  const summary = parseSessionSummary(rows);

  summaryMemo.set(sessionId, { key, summary });
  if (summaryMemo.size > SUMMARY_MEMO_MAX_ENTRIES) {
    const oldest = summaryMemo.keys().next().value;
    if (oldest !== undefined) summaryMemo.delete(oldest);
  }
  return { ...summary };
}

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

  const summary = await getParsedSummaryMemoized(sessionId, database);

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
