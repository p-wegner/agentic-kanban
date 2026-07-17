import { sessions, sessionMessages } from "@agentic-kanban/shared/schema";
import { eq } from "drizzle-orm";
import { db } from "../../db/index.js";
import type { Database } from "../../db/index.js";
import type { SessionSummary } from "@agentic-kanban/shared";
import { readStdoutFromFile } from "./stdout-file.js";

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
