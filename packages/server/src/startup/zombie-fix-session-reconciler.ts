import { count } from "drizzle-orm/sql";
import { issues, preferences, sessionMessages, sessions, workspaces } from "@agentic-kanban/shared/schema";
import { and, eq, lt } from "drizzle-orm";
import type { Database } from "../db/index.js";
import { db } from "../db/index.js";
import type { BoardEvents } from "../services/board-events.js";
import { PREF_RECONCILER_ZOMBIE_FIX_ENABLED } from "../constants/preference-keys.js";

/** Grace window: a fix-and-merge session must be this old before it is a candidate. */
const GRACE_WINDOW_MS = 60_000;

export interface ZombieFixSessionReconcilerDeps {
  database?: Database;
  boardEvents: BoardEvents;
  /**
   * Override enabled state for testing. When undefined (production path), the reconciler
   * reads the live preference from the DB at each tick.
   */
  enabled?: boolean;
}

/**
 * Detect and recover zombie fix-and-merge (or review) sessions: sessions that are
 * marked 'running' but have produced zero output messages after the grace window,
 * indicating a failed launch (1s/zero-token sessions seen in board-monitor logs).
 *
 * For each zombie:
 * 1. If the provider process is dead (or no PID), mark the session 'stopped'.
 * 2. Reset the workspace from 'fixing' (or 'reviewing') back to 'idle' so the next
 *    monitor pass can act — either re-trigger fix-and-merge or surface the failure.
 * 3. Broadcast 'workspace_idle' so the board updates immediately.
 *
 * Crash-safe and idempotent: skips sessions that already have output or that
 * are still within the grace window, and skips if a newer running session exists
 * for the same workspace.
 */
export async function reconcileZombieFixSessions(deps: ZombieFixSessionReconcilerDeps): Promise<number> {
  const database = deps.database ?? db;

  const isEnabled = deps.enabled !== undefined
    ? deps.enabled
    : await (async () => {
        try {
          const row = await database
            .select({ value: preferences.value })
            .from(preferences)
            .where(eq(preferences.key, PREF_RECONCILER_ZOMBIE_FIX_ENABLED))
            .limit(1);
          return row.length === 0 || row[0].value !== "false";
        } catch {
          return true;
        }
      })();

  if (!isEnabled) {
    console.log("[zombie-fix] reconciler disabled via preference — skipping tick");
    return 0;
  }

  const cutoff = new Date(Date.now() - GRACE_WINDOW_MS).toISOString();

  // Find sessions that are 'running', triggered by fix-and-merge or review,
  // and started before the grace window.
  const candidates = await database
    .select({
      sessionId: sessions.id,
      workspaceId: sessions.workspaceId,
      pid: sessions.pid,
      startedAt: sessions.startedAt,
      triggerType: sessions.triggerType,
    })
    .from(sessions)
    .where(
      and(
        eq(sessions.status, "running"),
        lt(sessions.startedAt, cutoff),
      ),
    );

  // Filter in JS: triggerType in (fix-and-merge, review).
  const fixOrReview = candidates.filter(
    (s) => s.triggerType === "fix-and-merge" || s.triggerType === "review",
  );

  let recovered = 0;

  for (const s of fixOrReview) {
    // Check if the process is still alive.
    let processAlive = false;
    if (s.pid != null) {
      try {
        process.kill(s.pid, 0); // No-op signal — just probes existence.
        processAlive = true;
      } catch {
        processAlive = false;
      }
    }

    if (processAlive) continue; // Real running session — leave it alone.

    // Check message count for this session.
    const msgCountRows = await database
      .select({ cnt: count() })
      .from(sessionMessages)
      .where(eq(sessionMessages.sessionId, s.sessionId));
    const msgCount = msgCountRows[0]?.cnt ?? 0;

    if (msgCount > 0) continue; // Has output — not a zombie.

    // Zombie confirmed: dead process + zero messages + past grace window.
    // Check workspace status first — only act on workspaces still in fixing/reviewing.
    // A concurrent transition (e.g. manual stop + re-launch) may have already changed it.
    const now = new Date().toISOString();

    try {
      const wsRows = await database
        .select({ id: workspaces.id, status: workspaces.status, issueId: workspaces.issueId })
        .from(workspaces)
        .where(eq(workspaces.id, s.workspaceId))
        .limit(1);

      if (wsRows.length === 0) continue;
      const ws = wsRows[0];

      if (ws.status !== "fixing" && ws.status !== "reviewing") continue;

      // Mark session stopped and reset workspace to idle atomically (best-effort).
      await database
        .update(sessions)
        .set({ status: "stopped", endedAt: now })
        .where(eq(sessions.id, s.sessionId));

      await database
        .update(workspaces)
        .set({ status: "idle", updatedAt: now })
        .where(eq(workspaces.id, s.workspaceId));

      // Resolve projectId for the board broadcast.
      const issueRows = await database
        .select({ projectId: issues.projectId })
        .from(issues)
        .where(eq(issues.id, ws.issueId))
        .limit(1);
      const projectId = issueRows[0]?.projectId;

      if (projectId) {
        deps.boardEvents.broadcast(projectId, "workspace_idle");
        deps.boardEvents.broadcast(projectId, "issue_updated");
      }

      console.log(
        `[zombie-fix] stopped zombie ${s.triggerType} session ${s.sessionId} (ws=${s.workspaceId}, pid=${s.pid ?? "none"}, msgs=0, age=${Math.round((Date.now() - new Date(s.startedAt).getTime()) / 1000)}s) — workspace reset to idle`,
      );
      recovered++;
    } catch (err) {
      console.warn(
        `[zombie-fix] failed to recover zombie session ${s.sessionId}:`,
        err instanceof Error ? err.message : err,
      );
    }
  }

  if (recovered > 0) console.log(`[zombie-fix] recovered ${recovered} zombie fix/review session(s)`);
  return recovered;
}

const DEFAULT_INTERVAL_MS = 60_000;

/** Run the zombie reconciler shortly after boot and then on an interval. */
export function startZombieFixSessionReconciler(
  deps: ZombieFixSessionReconcilerDeps,
  intervalMs = DEFAULT_INTERVAL_MS,
): ReturnType<typeof setInterval> {
  const tick = () => {
    reconcileZombieFixSessions(deps).catch((err) =>
      console.warn("[zombie-fix] cycle error:", err instanceof Error ? err.message : err),
    );
  };
  setTimeout(tick, 30_000);
  return setInterval(tick, intervalMs);
}
