import { isTerminalStatusName } from "@agentic-kanban/shared";
import {
  pluginLoopConvergedPreferenceKey,
  pluginLoopPausedPreferenceKey,
  type PluginManifest,
} from "@agentic-kanban/shared/lib/plugin-manifest";
import type { Database } from "../../db/index.js";
import {
  listPluginLoopIssues,
  listPluginLoopSessionStats,
  listPluginLoopUnmergedWorkspaces,
} from "../../repositories/plugins.repository.js";
import { latestPluginLoopEvent } from "../../repositories/plugin-loop-events.repository.js";
import { getPreference } from "../../repositories/preferences.repository.js";
import { gateBlockingTickets } from "../plugin-loop-accounting.js";
import { selectLoopStall } from "../plugin-loop-stall.js";
import { reconcileProgressStepStates } from "../plugin-loop-step-state.js";
import type { LoopStatus } from "../plugin-loop-types.js";
import { keyPrefix, parseAdvancePayload } from "./loop-identity.js";

/**
 * The READ side of a plugin loop: everything the UI needs about a loop's current state, with the
 * (possibly slow) planner never run.
 *
 * This is a projection, not a decision — it derives the loop's display state from three sources
 * that can disagree, and every reconciliation rule between them lives here:
 * - the loop's TICKETS (open/closed counts, stranded refs, which of them block the gate),
 * - the last `advance` event's payload, which carries the planner's own claims
 *   (note/gate/progress/checks/startNotices),
 * - and the `paused`/`converged` preferences, which are the board's persisted verdicts.
 *
 * Where the planner's claim and the board's own observation disagree, the OBSERVATION wins
 * (#479/#481) — see `reconcileProgressStepStates`.
 */

/**
 * `includeCosts` (default true) controls the session-cost rollup (#294): an unbounded
 * sessions→workspaces→issues join plus a JSON.parse per stats blob. The cross-project inbox poll
 * only needs gate/openTickets and passes `false` to skip it entirely (2026-08-11 perf audit);
 * cost-skipped statuses carry `totalCostUsd: null`.
 */
export async function readLoopStatuses(
  manifest: PluginManifest,
  pluginSlug: string,
  projectId: string,
  options: { includeCosts?: boolean },
  database: Database,
): Promise<LoopStatus[]> {
  const includeCosts = options.includeCosts !== false;
  return Promise.all((manifest.loops ?? []).map(async (loop) => {
    // The per-loop query bundle used to be 5-7 SERIAL awaits; nothing below
    // depends on another query's result, so they run as one round-trip wave.
    const [rows, pausedValue, convergedValue, lastAdvance, unmerged, totalCostUsd] = await Promise.all([
      listPluginLoopIssues(projectId, keyPrefix(pluginSlug, loop.name), database),
      getPreference(pluginLoopPausedPreferenceKey(pluginSlug, loop.name, projectId), database),
      getPreference(pluginLoopConvergedPreferenceKey(pluginSlug, loop.name, projectId), database),
      // The latest advance's persisted plan extras (gate/progress/checks/note) ARE the loop's
      // current display state — surfacing them here is what lets the panel render an approval
      // card or a stepper without re-running the (possibly slow) planner.
      latestPluginLoopEvent({ pluginSlug, loopName: loop.name, projectId }, "advance", database),
      listPluginLoopUnmergedWorkspaces(projectId, keyPrefix(pluginSlug, loop.name), database),
      includeCosts ? sumLoopSessionCosts(pluginSlug, loop.name, projectId, database) : Promise.resolve(null),
    ]);
    const payload = parseAdvancePayload(lastAdvance);
    const gate = payload?.gate ?? null;
    const { gateSince, gateRecommendation } = await readGateChips(
      { pluginSlug, loopName: loop.name, projectId },
      gate?.id ?? null,
      database,
    );
    const openRows = rows.filter((r) => !isTerminalStatusName(r.statusName));
    // #479/#481 — a planner only ever reports "generating" because a ticket EXISTS for the
    // step; it cannot see whether a session is actually live. Override that claim with what
    // the board can see: no workspace at all → "planned" (nothing running, nothing will start
    // unless Start Mode or a human does), a workspace but no LIVE one → "stalled" (the agent
    // exited, nothing landed, and nothing will ever close the ticket on its own). Every other
    // reported state is left untouched.
    const rawProgress = payload?.progress ?? null;
    const progress = rawProgress
      ? { steps: reconcileProgressStepStates(rawProgress.steps, openRows) }
      : null;
    return {
      name: loop.name,
      label: loop.label ?? loop.name,
      description: loop.description ?? null,
      skill: loop.skill,
      openTickets: openRows.length,
      // The open tickets THEMSELVES, not just their count (#429). The pane said "1 ticket(s)
      // still open" and offered no way to reach the work — the reader had to go to the board
      // and find it. Costs nothing: these rows are already loaded for the counts above.
      openTicketRefs: openRows.map((r) => ({
        issueId: r.id,
        issueNumber: r.issueNumber,
        statusName: r.statusName,
        stranded: r.hasAnyWorkspace && !r.hasLiveWorkspace,
      })),
      // #431 — which open tickets actually suppress the gate card. Decided HERE, from the unit
      // keys, rather than by the client comparing a bare count: `openTickets` includes the
      // gate's OWN ticket, so anything holding that ticket non-terminal used to hide the gate.
      gateBlockedBy: gateBlockingTickets(gate, progress, openRows).map((r) => r.issueNumber),
      closedTickets: rows.filter((r) => isTerminalStatusName(r.statusName)).length,
      paused: pausedValue === "true",
      converged: convergedValue === "true",
      note: payload?.note ?? null,
      // Still the row's `createdAt` after #448: a collapsed repeat RESTAMPS that row to the
      // latest advance, so this keeps meaning "the loop was polled at ...". See
      // `collapseRepeatedNoOpAdvance`.
      lastAdvanceAt: lastAdvance?.createdAt ?? null,
      gate: payload?.gate ?? null,
      gateSince,
      progress,
      checks: payload?.checks ?? null,
      // What the last advance did about starting its tickets (#357). The surface must be able to
      // say "step 5 planned, starting now" rather than leaving a blank where the gate card was.
      startNotices: payload?.startNotices ?? [],
      // Staleness filtering, ordering and CLASSIFICATION all live in `plugin-loop-stall.ts`
      // (#363): the query now returns two genuinely different stalls and they need different
      // affordances, so the surface has to be told which one it is looking at.
      awaitingMerge: selectLoopStall(unmerged, gate, progress),
      gateRecommendation,
      totalCostUsd,
    };
  }));
}

/**
 * The two chips a gate carries beyond the gate itself: how long it has been open, and the
 * butler's recommendation for it. Both are keyed on the CURRENT gate id — an event left behind
 * by a previous gate must not decorate this one — and both degrade to nothing on a malformed
 * payload rather than failing the status read.
 */
async function readGateChips(
  key: { pluginSlug: string; loopName: string; projectId: string },
  gateId: string | null,
  database: Database,
): Promise<{ gateSince: string | null; gateRecommendation: LoopStatus["gateRecommendation"] }> {
  if (!gateId) return { gateSince: null, gateRecommendation: null };
  // `gate-reached` is written once per NEW gate id, so its timestamp is the gate's
  // true birth — unlike the advance row, which is restamped every monitor cycle.
  const [reachedRow, recoRow] = await Promise.all([
    latestPluginLoopEvent(key, "gate-reached", database),
    latestPluginLoopEvent(key, "gate-recommendation", database),
  ]);
  let gateSince: string | null = null;
  let gateRecommendation: LoopStatus["gateRecommendation"] = null;
  try {
    const reached = reachedRow?.payloadJson ? JSON.parse(reachedRow.payloadJson) as { gateId?: string } : null;
    if (reached?.gateId === gateId) gateSince = reachedRow?.createdAt ?? null;
  } catch { /* malformed event — fall back to no age */ }
  try {
    const reco = recoRow?.payloadJson ? JSON.parse(recoRow.payloadJson) as { gateId?: string; actionId?: string; reason?: string } : null;
    if (reco?.gateId === gateId && typeof reco.actionId === "string") {
      gateRecommendation = { actionId: reco.actionId, reason: reco.reason ?? "" };
    }
  } catch { /* malformed event — no chip */ }
  return { gateSince, gateRecommendation };
}

/**
 * Cost rollup (#294): sessions → workspaces → unit tickets, folded here so the
 * plugin panel can show "$X so far" without a second request. Cost is decoration —
 * a failure never blanks the status, it just reports $0.
 */
async function sumLoopSessionCosts(
  pluginSlug: string,
  loopName: string,
  projectId: string,
  database: Database,
): Promise<number> {
  let totalCostUsd = 0;
  try {
    const statRows = await listPluginLoopSessionStats(projectId, keyPrefix(pluginSlug, loopName), database);
    for (const statRow of statRows) {
      try {
        totalCostUsd += Number((JSON.parse(statRow.stats ?? "{}") as { totalCostUsd?: unknown }).totalCostUsd ?? 0) || 0;
      } catch { /* skip unparseable stats */ }
    }
  } catch { /* cost is decoration — never blank the panel for it */ }
  return totalCostUsd;
}
