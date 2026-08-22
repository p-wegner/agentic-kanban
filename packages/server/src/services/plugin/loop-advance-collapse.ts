import type { Database } from "../../db/index.js";
import {
  restampPluginLoopEvent,
  type PluginLoopEventRow,
} from "../../repositories/plugin-loop-events.repository.js";
import type { AdvanceEventPayload } from "../plugin-loop-types.js";

/**
 * #448 — the no-op-advance collapse contract, for anything rendering the loop timeline.
 *
 * MEASURED PROBLEM: the monitor re-plans a gated loop every ~4 minutes, and every one of those
 * advances used to persist a byte-identical `advance` row carrying the full gate note. On the live
 * `mealplan` loop that was ~50 consecutive identical rows over 13 hours (~360 rows/day per gated
 * loop), which pushed `gate-reached`, `gate-resolved`, `converged`, butler pre-reads and every step
 * completion out of the client's `limit=50` window — the timeline became pure heartbeat.
 *
 * THE CONTRACT, which consumers may rely on:
 * - An `advance` row is inserted whenever the advance DID something (planned/created/skipped/capped)
 *   OR its payload differs in any way from the previous `advance` — note, gate, progress, checks,
 *   startNotices. So the FIRST no-op after any state change is always a real, new row.
 * - A repeat of an unchanged no-op inserts NOTHING. Instead the previous row is restamped:
 *   `repeatCount` incremented, `firstSeenAt` pinned to the run's start, and `createdAt` moved to
 *   NOW — because `createdAt` is what every reader already means by "when did this loop last
 *   advance" (`lastAdvanceAt`, the timeline's ordering, and the monitor's blocked-advance interval
 *   gate in `plugin-loop-monitor.ts`, which would stop throttling if the stamp went stale).
 * - No information is lost. The count is exact (`repeatCount: 47` stands for 47 advances), the run
 *   is bounded by `firstSeenAt`…`createdAt`, and liveness is unchanged from before #448.
 * - A row with no `repeatCount` happened exactly once (also true of every row written before #448).
 */

/**
 * Is this advance a pure no-op? It planned nothing, created nothing, skipped nothing and capped
 * nothing; all it carries is the planner's restated view of the world (note/gate/progress).
 */
export function isNoOpAdvance(payload: AdvanceEventPayload): boolean {
  return payload.planned === 0
    && payload.created.length === 0
    && payload.skippedExisting === 0
    && payload.capped === 0;
}

/**
 * The part of an advance payload that says WHAT HAPPENED, with the repeat bookkeeping stripped.
 * Both sides are built by the same object literal (and a stored payload round-trips through
 * JSON.parse, which preserves key order), so string equality is a sound identity test here.
 */
export function advanceIdentity(payload: AdvanceEventPayload): string {
  const { repeatCount: _count, firstSeenAt: _first, ...rest } = payload;
  return JSON.stringify(rest);
}

/** Returns true when it collapsed (caller must NOT insert). See the module header for the contract. */
export async function collapseRepeatedNoOpAdvance(
  priorRow: PluginLoopEventRow | null,
  priorPayload: AdvanceEventPayload | null,
  next: AdvanceEventPayload,
  now: string,
  database: Database,
): Promise<boolean> {
  if (!priorRow || !priorPayload) return false;
  if (!isNoOpAdvance(next)) return false;
  if (advanceIdentity(priorPayload) !== advanceIdentity(next)) return false;
  await restampPluginLoopEvent(
    priorRow.id,
    {
      ...priorPayload,
      repeatCount: (priorPayload.repeatCount ?? 1) + 1,
      firstSeenAt: priorPayload.firstSeenAt ?? priorRow.createdAt,
    },
    now,
    database,
  );
  return true;
}
