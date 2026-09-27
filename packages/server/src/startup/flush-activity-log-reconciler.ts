/**
 * #1253 (#1246 follow-up, decision 020 part 3): "every flush, and every heal-state transition,
 * appears as an activity-log entry."
 *
 * `flush-state.json` has no writer yet (#1247/#1248 own that) and no push notification when it
 * changes — the board only ever re-reads it on demand. This sweep is the periodic re-read: for
 * every project with a stable checkout, it diffs the current flush records against a per-project
 * cursor (`flush_activity_log_state_<id>`, the last state logged for each flush id) and appends a
 * `board_health_events` row for anything new — a flush's first appearance, and every subsequent
 * state move (`flushed -> sweeping -> ... -> merged-back`/`abandoned`, decision 020 part 4's
 * state machine). See `lib/flush-activity-events.ts` for the pure diff.
 */
import { projectPref } from "@agentic-kanban/shared/lib/dynamic-preference-keys";
import type { Database } from "../db/index.js";
import { getProjectIdsWithRepoPath } from "../repositories/project.repository.js";
import { getPreference, setPreference } from "../repositories/preferences.repository.js";
import { logBoardHealthEvent } from "../repositories/board-health-events.repository.js";
import { readFlushState, sortFlushes } from "../services/flush-state.js";
import { resolveStableCheckoutFor } from "../services/rc-state.js";
import { diffFlushActivityLog, describeFlushActivityEvent, parseFlushActivityLogCursor } from "../lib/flush-activity-events.js";
import { emptyPassReport, recordActed, recordSkipped, type PassReport } from "../lib/pass-report.js";
import { startPeriodicSweep, type PeriodicSweepHandle } from "../lib/periodic-sweep.js";

const flushActivityLogStatePref = projectPref("flush_activity_log_state");

/** How often the sweep re-reads flush-state.json for every project. */
const SWEEP_INTERVAL_MS = 5 * 60 * 1000;

export interface FlushActivityLogSweepResult extends PassReport {
  logged: Array<{ projectId: string; flushId: string; state: string }>;
}

/**
 * `database` is REQUIRED, not defaulted to the `db` singleton (#715): `startup/` may not grow a
 * new raw-persistence offender — the caller (`background-services.ts`) injects the connection it
 * was itself handed, and every read here goes through a repository accessor.
 */
export async function reconcileFlushActivityLog(
  opts: {
    database: Database;
    log?: (message: string) => void;
  },
): Promise<FlushActivityLogSweepResult> {
  const { database } = opts;
  const log = opts.log ?? ((message: string) => console.log(`[flush-activity-log] ${message}`));

  const projectRows = await getProjectIdsWithRepoPath(database);
  const result: FlushActivityLogSweepResult = { ...emptyPassReport(projectRows.length), logged: [] };

  for (const project of projectRows) {
    try {
      const stableCheckout = resolveStableCheckoutFor(project.repoPath);
      const state = readFlushState(stableCheckout);
      if (state.flushes.length === 0) {
        recordSkipped(result, project.id, "no flushes");
        continue;
      }
      const cursorKey = flushActivityLogStatePref.key(project.id);
      const cursor = parseFlushActivityLogCursor(await getPreference(cursorKey, database));
      const { entries, nextCursor } = diffFlushActivityLog(sortFlushes(state.flushes), cursor);
      if (entries.length === 0) {
        recordSkipped(result, project.id, "no new transitions");
        continue;
      }
      for (const entry of entries) {
        await logBoardHealthEvent({
          projectId: project.id,
          cycleId: `flush-${entry.flush.id}`,
          eventType: entry.isNewFlush ? "observation" : "action",
          category: "flush",
          summary: describeFlushActivityEvent(entry),
          details: { flushId: entry.flush.id, state: entry.state, sweepTarget: entry.flush.sweepTarget, memberIssueNumbers: entry.flush.memberIssueNumbers },
        }, database);
        result.logged.push({ projectId: project.id, flushId: entry.flush.id, state: entry.state });
        log(`project ${project.id}: ${describeFlushActivityEvent(entry)}`);
      }
      await setPreference(cursorKey, JSON.stringify(nextCursor), database);
      recordActed(result, project.id, "logged");
    } catch (err) {
      recordSkipped(result, project.id, `error: ${err instanceof Error ? err.message : String(err)}`);
      log(`project ${project.id}: sweep failed (non-fatal): ${err instanceof Error ? err.message : err}`);
    }
  }
  return result;
}

let sweep: PeriodicSweepHandle | null = null;

export function startFlushActivityLogReconciler(opts: { database: Database; intervalMs?: number }): void {
  stopFlushActivityLogReconciler();
  sweep = startPeriodicSweep({
    name: "flush-activity-log",
    intervalMs: opts.intervalMs ?? SWEEP_INTERVAL_MS,
    tick: () => reconcileFlushActivityLog({ database: opts.database }),
  });
}

export function stopFlushActivityLogReconciler(): void {
  sweep?.stop();
  sweep = null;
}
