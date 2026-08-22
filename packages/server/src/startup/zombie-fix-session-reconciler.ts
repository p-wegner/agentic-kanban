import { count } from "drizzle-orm/sql";
import { issues, preferences, sessionMessages, sessions, workspaces } from "@agentic-kanban/shared/schema";
import { and, eq, inArray, lt } from "drizzle-orm";
import type { Database } from "../db/index.js";
import { db } from "../db/index.js";
import type { BoardEventSink } from "../services/board-events.js";
import { PREF_RECONCILER_ZOMBIE_FIX_ENABLED } from "../constants/preference-keys.js";
import { setWorkspaceStatus } from "../repositories/workspace-status.repository.js";
import { getMergeJob } from "../services/merge-job.service.js";
import { startPeriodicSweep, type PeriodicSweepHandle } from "../lib/periodic-sweep.js";
import { isPidAlive } from "../lib/pid.js";
import type { LivenessVerdict } from "../services/remote-session-liveness.js";
import { probeRemoteSessionLiveness } from "../services/fleet-liveness-probe.js";

/** Grace window: a fix-and-merge session must be this old before it is a candidate. */
const GRACE_WINDOW_MS = 60_000;

/**
 * A session with NO recorded PID gets a much longer grace (#270): the PID is written after the
 * agent process spawns, and under board load a launch can take minutes between the session row
 * appearing and the process existing. The zombie-fixer killed a review session at age 73s whose
 * own launch had not finished registering — and reset the workspace out from under a merge.
 */
const PIDLESS_GRACE_WINDOW_MS = 5 * 60_000;

export interface ZombieFixSessionReconcilerDeps {
  database?: Database;
  boardEvents: BoardEventSink;
  /**
   * Override enabled state for testing. When undefined (production path), the reconciler
   * reads the live preference from the DB at each tick.
   */
  enabled?: boolean;
  /** Epoch-ms clock override (arithmetic only — nothing here persists it). */
  nowMs?: number;
  /**
   * Injected for testing — defaults to probeRemoteSessionLiveness. A session on a
   * fleet worker has no local pid, so the pidless-grace rule below would have
   * reaped every remote review/fix session (#744).
   */
  probeRemote?: (
    row: { workerId: string; startedAt?: string | null },
    database: Database,
    opts: { nowMs: number },
  ) => Promise<LivenessVerdict>;
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
  const nowMs = deps.nowMs ?? Date.now();
  const probeRemote = deps.probeRemote ?? probeRemoteSessionLiveness;

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

  const cutoff = new Date(nowMs - GRACE_WINDOW_MS).toISOString();

  // Find sessions that are 'running', triggered by fix-and-merge or review,
  // and started before the grace window.
  const candidates = await database
    .select({
      sessionId: sessions.id,
      workspaceId: sessions.workspaceId,
      pid: sessions.pid,
      workerId: sessions.workerId,
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

  // One grouped count for all candidates instead of a COUNT(*) per candidate
  // inside the loop (this reconciler ticks every 60s).
  const msgCountBySession = new Map<string, number>();
  if (fixOrReview.length > 0) {
    const countRows = await database
      .select({ sessionId: sessionMessages.sessionId, cnt: count() })
      .from(sessionMessages)
      .where(inArray(sessionMessages.sessionId, fixOrReview.map((s) => s.sessionId)))
      .groupBy(sessionMessages.sessionId);
    for (const row of countRows) msgCountBySession.set(row.sessionId, row.cnt);
  }

  let recovered = 0;

  for (const s of fixOrReview) {
    // #744: a session dispatched to a fleet worker has no local pid EVER, so the
    // pidless rule below (reap after 5 minutes with no process) reaped live remote
    // review/fix sessions on schedule. Remote liveness is a different question with a
    // different answer set — ask the one seam that knows, and HOLD on `unknown`.
    if (s.workerId) {
      const verdict = await probeRemote({ workerId: s.workerId, startedAt: s.startedAt }, database, { nowMs })
        .catch((err) => {
          console.error(`[zombie-fix] remote liveness probe failed for session ${s.sessionId}`, err);
          return { liveness: "unknown" as const, reason: "remote liveness probe failed" };
        });
      if (verdict.liveness !== "dead") {
        console.log(
          `[zombie-fix] holding remote session ${s.sessionId} on worker ${s.workerId}: ${verdict.reason}`,
        );
        continue;
      }
      console.warn(`[zombie-fix] remote session ${s.sessionId} is unrecoverable: ${verdict.reason}`);
    } else {
      // #545: this probe used to read EPERM as DEAD, so an agent running under a protected
      // PID would have been "recovered" out from under itself. `isPidAlive` is the one rule.
      if (s.pid != null && isPidAlive(s.pid)) continue; // Real running session — leave it alone.

      // No PID yet: the launch may simply not have finished registering — give it the long
      // grace before treating the missing process as proof of death (#270).
      if (s.pid == null && Date.parse(s.startedAt) > nowMs - PIDLESS_GRACE_WINDOW_MS) continue;
    }

    // A merge in flight owns this workspace (#270): resetting it to idle here abandoned an
    // in-flight merge silently (no verdict, mergedAt and mergeError both null). Let the merge
    // finish or fail on its own; a genuinely-dead session is collected on a later tick.
    if (getMergeJob(s.workspaceId)?.state === "running") {
      console.log(`[zombie-fix] session ${s.sessionId} looks zombie but workspace ${s.workspaceId} has a merge in flight — skipping reset`);
      continue;
    }

    // Check message count for this session (prefetched above).
    const msgCount = msgCountBySession.get(s.sessionId) ?? 0;

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

      await setWorkspaceStatus(database, s.workspaceId, "idle", { now });

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
        `[zombie-fix] stopped zombie ${s.triggerType} session ${s.sessionId} (ws=${s.workspaceId}, pid=${s.pid ?? "none"}, msgs=0, age=${Math.round((nowMs - new Date(s.startedAt).getTime()) / 1000)}s) — workspace reset to idle`,
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

let activeZombieFixSweep: PeriodicSweepHandle | null = null;

export function stopZombieFixSessionReconciler(): void {
  activeZombieFixSweep?.stop();
  activeZombieFixSweep = null;
}

/** Run the zombie reconciler shortly after boot and then on an interval. */
export function startZombieFixSessionReconciler(
  deps: ZombieFixSessionReconcilerDeps,
  intervalMs = DEFAULT_INTERVAL_MS,
): PeriodicSweepHandle {
  stopZombieFixSessionReconciler();
  activeZombieFixSweep = startPeriodicSweep({
    name: "zombie-fix",
    tick: () => reconcileZombieFixSessions(deps),
    bootDelayMs: 30_000,
    intervalMs,
  });
  return activeZombieFixSweep;
}

