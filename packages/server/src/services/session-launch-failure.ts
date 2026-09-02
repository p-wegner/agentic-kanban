import { readSessionStats } from "@agentic-kanban/shared/lib/session-stats-blob";

/**
 * Did this session fail to launch? ONE definition, shared by every view that shows it (#1003).
 *
 * There were two, and they disagreed about the same session. `workspace-launch-failures.service.ts`
 * had been corrected to trust the signal the session lifecycle stamps into the stats blob;
 * `workspace-timeline.service.ts` kept the ORIGINAL heuristic — "no `inputTokens` and no
 * `outputTokens` means the agent produced nothing" — so the Launch Failures panel and the
 * Timeline tab beside it labelled #999's two healthy 100-minute sessions differently.
 *
 * The heuristic is not merely redundant, it is wrong: token counts are bookkeeping the result
 * event happens to carry, and a session that loses them (as every completed session did while
 * #1002's lost-update was live) is not thereby a session that produced no output. Classification
 * belongs to the lifecycle, which watches the run; a reader of the blob only reports it.
 *
 * Order of trust:
 *  1. `launchFailure === true` — definitive, the lifecycle stamped it.
 *  2. `success === false` with `launchFailure` unset — a recorded provider result that did not
 *     succeed (e.g. an error result event).
 *
 * A session with no stats at all (still running, or stats not yet persisted) is NOT a failure:
 * absence of evidence is what the old heuristic kept reading as evidence.
 */
export function isLaunchFailedSession(session: { stats: string | null }): boolean {
  if (!session.stats) return false;
  try {
    const s = readSessionStats(session.stats);
    if (s.launchFailure === true) return true;
    if (s.success === false) return true;
  } catch {
    // A blob we cannot parse says nothing either way — the same as no blob.
  }
  return false;
}

/**
 * A session that ended within a second of starting never got as far as producing anything.
 *
 * Kept separate from `isLaunchFailedSession` on purpose: this is a statement about the process,
 * not about the stats blob, and only the timeline uses it. It survives the #1003 unification
 * because it was never part of the disagreement — a sub-second exit is a launch that did not
 * happen, whatever the blob later says.
 */
export function endedWithinLaunchWindow(session: { startedAt: string; endedAt: string | null }): boolean {
  if (!session.endedAt) return false;
  return new Date(session.endedAt).getTime() - new Date(session.startedAt).getTime() <= 1000;
}
