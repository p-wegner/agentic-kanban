/**
 * Pure: which flush/heal-state transitions are new since the last board-health-event sweep
 * (#1253, #1246 follow-up).
 *
 * There is no push notification for a flush-state write — the writer is #1247/#1248, not this
 * ticket, and today nothing calls it in production. The board only ever RE-READS
 * `flush-state.json` on demand (the delivery chip, the tracker, `GET /:id/flushes`). So logging
 * "every flush, and every heal-state transition" means comparing each read against what was
 * already logged and emitting an entry for anything new — one row per flush id the first time it
 * is seen, and one more each time its `state` moves.
 */
import type { FlushRecord, FlushState } from "@agentic-kanban/shared/types";

/** Per-project cursor: the last state logged for each flush id this sweep has already seen. */
export interface FlushActivityLogCursor {
  /** flush id -> last logged state */
  loggedStates: Record<string, FlushState>;
}

export function emptyFlushActivityLogCursor(): FlushActivityLogCursor {
  return { loggedStates: {} };
}

export function parseFlushActivityLogCursor(raw: string | null | undefined): FlushActivityLogCursor {
  if (!raw) return emptyFlushActivityLogCursor();
  try {
    const parsed = JSON.parse(raw) as { loggedStates?: unknown };
    const loggedStates: Record<string, FlushState> = {};
    if (parsed && typeof parsed.loggedStates === "object" && parsed.loggedStates !== null) {
      for (const [id, state] of Object.entries(parsed.loggedStates as Record<string, unknown>)) {
        if (typeof state === "string") loggedStates[id] = state as FlushState;
      }
    }
    return { loggedStates };
  } catch {
    return emptyFlushActivityLogCursor();
  }
}

export interface FlushActivityLogEntry {
  flush: FlushRecord;
  /** The state this entry reports (equals `flush.state` — carried for clarity at call sites). */
  state: FlushState;
  /** Whether this is the flush's FIRST appearance (vs. a state transition on an already-seen flush). */
  isNewFlush: boolean;
}

/**
 * Diff the current flush records against the cursor. Returns one entry per flush that is either
 * unseen (isNewFlush: true) or whose state moved since the cursor was last saved — in that
 * order, newest-appearing-first is NOT assumed; callers sort `flushes` themselves if order
 * matters. Also returns the cursor to persist (the state includes every CURRENT flush id, so a
 * flush record removed from the file — never happens today, append-only — simply stops being
 * tracked rather than leaving a permanent ghost entry).
 */
export function diffFlushActivityLog(
  flushes: readonly FlushRecord[],
  cursor: FlushActivityLogCursor,
): { entries: FlushActivityLogEntry[]; nextCursor: FlushActivityLogCursor } {
  const entries: FlushActivityLogEntry[] = [];
  const loggedStates: Record<string, FlushState> = {};
  for (const flush of flushes) {
    const lastLogged = cursor.loggedStates[flush.id];
    if (lastLogged === undefined) {
      entries.push({ flush, state: flush.state, isNewFlush: true });
    } else if (lastLogged !== flush.state) {
      entries.push({ flush, state: flush.state, isNewFlush: false });
    }
    loggedStates[flush.id] = flush.state;
  }
  return { entries, nextCursor: { loggedStates } };
}

/** One-line summary for a flush activity-log entry — shared by the sweep and its tests. */
export function describeFlushActivityEvent(entry: FlushActivityLogEntry): string {
  const { flush, state, isNewFlush } = entry;
  return isNewFlush
    ? `flush ${flush.id} started (${flush.memberIssueNumbers.length} member ticket${flush.memberIssueNumbers.length === 1 ? "" : "s"}, target ${flush.sweepTarget})`
    : `flush ${flush.id} -> ${state}`;
}
