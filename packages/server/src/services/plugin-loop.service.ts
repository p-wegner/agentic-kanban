import {
  buildPluginPlaceholderVars,
  pluginLoopConvergedPreferenceKey,
  pluginLoopPausedPreferenceKey,
  type PluginManifest,
} from "@agentic-kanban/shared/lib/plugin-manifest";
import { setPreferenceChecked } from "@agentic-kanban/shared/lib/checked-preference-write";
import { parseBoolSetting } from "@agentic-kanban/shared/lib/settings-registry";
import { toPrefMap } from "@agentic-kanban/shared/lib/preference-map";
import {
  insertPluginLoopEvent,
  latestPluginLoopEvent,
  listPluginLoopEvents,
} from "../repositories/plugin-loop-events.repository.js";
import { getAllPreferences, getPreference } from "../repositories/preferences.repository.js";
import { resolveStartPolicy } from "./start-policy.service.js";
import { describeLoopStartOutcome, startPlannedLoopTickets, type LoopStartOutcome } from "./plugin-loop-start.service.js";
import { describeExistingUnits } from "./plugin-loop-unit-state.js";
import { collapseRepeatedNoOpAdvance } from "./plugin/loop-advance-collapse.js";
import { loopAdvanceLockKey, withLoopAdvanceLock } from "./plugin/loop-advance-lock.js";
import { notifyGateReached } from "./plugin/loop-gate-notify.js";
import { resolveLoopGate, type ResolveGateArgs } from "./plugin/loop-gate-resolve.js";
import { findLoop, parseAdvancePayload, PluginLoopError } from "./plugin/loop-identity.js";
import { runLoopPlan } from "./plugin/loop-plan.js";
import { readLoopStatuses } from "./plugin/loop-status.js";
import { ticketPlannedUnits } from "./plugin/loop-unit-tickets.js";

/**
 * Board-owned converging analysis loops (plugin manifest `loops`).
 *
 * The division of labour is the whole point. The PLUGIN contributes one
 * deterministic, judgment-free command — `plan` — that prints the work units
 * still outstanding. The BOARD does everything that involves running an agent:
 * each unit becomes a normal ticket carrying the loop's skill, and the board's
 * own monitor starts those tickets within the project's WIP limit, under the
 * Strategy Bullseye's provider selection and the auth-rotation ring (so a
 * quota-exhausted profile rotates mid-loop instead of stalling the sweep), and
 * through the usual review/merge gates.
 *
 * So a loop is *resumable and observable for free*: its state is tickets on the
 * board, not a private run-log, and killing the server loses nothing.
 *
 * **This module is the ADVANCE — the one path that runs a round.** Everything an
 * advance needs but that is not itself a step of it lives beside it (#727), so the
 * round's shape reads in one screen:
 *
 * | Concern | Module |
 * |---|---|
 * | naming/finding a loop, reading its last advance | `plugin/loop-identity.ts` |
 * | serializing overlapping advances (#249) | `plugin/loop-advance-lock.ts` |
 * | running the planner subprocess, parsing its plan (#662) | `plugin/loop-plan.ts` |
 * | the unit-id dedupe + ticket creation | `plugin/loop-unit-tickets.ts` |
 * | the no-op-advance collapse contract (#448) | `plugin/loop-advance-collapse.ts` |
 * | gate notifications and the recommendation retry (#287/#367) | `plugin/loop-gate-notify.ts` |
 * | applying a human's gate decision (#286) | `plugin/loop-gate-resolve.ts` |
 * | the READ side the UI polls | `plugin/loop-status.ts` |
 *
 * **Unit identity is the planner's contract**, and `converged` is a claim about the JOB
 * rather than the currently-ready set — the two invariants that fail SILENTLY. Each is
 * stated where it is implemented (`plugin/loop-unit-tickets.ts`, and `persistConvergence`
 * below) and guarded by `plugin-loop-invariants.test.ts`.
 */

export { PluginLoopError };
export type { GateResolveResult } from "./plugin/loop-gate-resolve.js";

import type {
  LoopCreatedTicket,
  LoopAdvanceResult,
  LoopStatus,
  PluginLoopDeps,
  AdvanceEventPayload,
} from "./plugin-loop-types.js";
import type { Database } from "../db/index.js";

export type { LoopCreatedTicket, LoopAdvanceResult, LoopStatus, PluginLoopDeps, AdvanceEventPayload };

/** Re-exported from its own module (#363) — see `plugin-loop-accounting.ts` for why. */
export { isLoopUnitAccountedForByPlanner } from "./plugin-loop-accounting.js";

/** Everything an advance (and a gate resolve, which re-plans) needs to identify its round. */
interface AdvanceArgs {
  manifest: PluginManifest;
  pluginSlug: string;
  pluginName?: string;
  /** Plugin ROW id — carried into the gate notification so receivers can deep-link (#300). */
  pluginRowId?: string | null;
  pluginLocalPath: string;
  loopName: string;
  projectId: string;
  projectName: string;
  repoPath: string;
  leadingRepoPath: string;
  /** Resolved by the caller from the loop's (or its skill's) declared `workflow`. */
  workflowTemplateId?: string | null;
}

export function createPluginLoopEngine(deps: PluginLoopDeps) {
  const { database, createIssue, createWorkspace, boardUrl, boardEvents } = deps;

  /** Per-loop ticket counts and display state for the UI, without running the planner. */
  async function loopStatuses(
    manifest: PluginManifest,
    pluginSlug: string,
    projectId: string,
    options: { includeCosts?: boolean } = {},
  ): Promise<LoopStatus[]> {
    return readLoopStatuses(manifest, pluginSlug, projectId, options, database);
  }

  /** Pause/resume a loop's monitor-driven auto-advance (`advanceDuePluginLoops`). */
  async function setLoopPaused(
    manifest: PluginManifest,
    pluginSlug: string,
    loopName: string,
    projectId: string,
    paused: boolean,
  ): Promise<void> {
    findLoop(manifest, loopName); // throws NOT_FOUND for an unknown loop name
    // Through the ONE checked write, like every other plugin pref (server/CLAUDE.md): a raw
    // `setPreference` here was the last plugin writer bypassing the guard/regen path.
    await setPreferenceChecked(database, [
      { key: pluginLoopPausedPreferenceKey(pluginSlug, loopName, projectId), value: paused ? "true" : "false" },
    ]);
    await insertPluginLoopEvent(
      { pluginSlug, loopName, projectId }, paused ? "paused" : "resumed", null, database,
    );
  }

  /**
   * Run one advance: plan → dedupe → create tickets. Idempotent with respect to
   * unit ids, so calling it repeatedly (a button, a monitor cycle) is safe — which
   * only holds because overlapping advances of one loop are serialized (#249).
   */
  async function advanceLoop(args: AdvanceArgs): Promise<LoopAdvanceResult> {
    return withLoopAdvanceLock(
      loopAdvanceLockKey(args.projectId, args.pluginSlug, args.loopName),
      () => advanceLoopSerialized(args),
    );
  }

  async function advanceLoopSerialized(args: AdvanceArgs): Promise<LoopAdvanceResult> {
    if (!createIssue) {
      throw new PluginLoopError("Loop advance is not available on this route", "BAD_REQUEST");
    }
    const loop = findLoop(args.manifest, args.loopName);
    const vars = buildPluginPlaceholderVars({
      // `{{repoPath}}` is the OUTPUT repo and `{{leadingRepoPath}}` is always the product repo
      // (#213) — a plugin that READS the source and WRITES to a sidecar needs both, and the
      // planner is the substitution site that decides whether sidecar mode works at all.
      outputRepoPath: args.repoPath,
      leadingRepoPath: args.leadingRepoPath,
      projectName: args.projectName,
      pluginPath: args.pluginLocalPath,
      boardUrl,
      projectId: args.projectId,
    });

    const plan = await runLoopPlan({
      loop, vars, repoPath: args.repoPath, pluginLocalPath: args.pluginLocalPath,
    });

    const { created, skippedExisting, capped, warnings } = await ticketPlannedUnits({
      loop,
      units: plan.units,
      pluginSlug: args.pluginSlug,
      projectId: args.projectId,
      workflowTemplateId: args.workflowTemplateId,
      createIssue,
      database,
    });

    const prefs = await getAllPreferences(database);
    const policy = resolveStartPolicy(toPrefMap(prefs), args.projectId);
    if (created.length > 0 && !policy.autoStartUnblocked) {
      warnings.push(
        `Start Mode is "${policy.mode}" — the board will NOT auto-start these tickets. `
        + `Set the project's Start Mode to "monitor" (Monitor view) to let the loop run hands-off.`,
      );
    }
    // #351 — start what we just planned, here, instead of minting a Backlog ticket and hoping a
    // monitor phase notices it. Approval is an event; depending on a poll is what produced the
    // measured 2.5-10 minute "the board is frozen after I approved" window. `startPlannedLoopTickets`
    // owns the honesty: it returns a per-ticket outcome the caller reports verbatim, and it does NOT
    // claim the agent is running (provisioning is minutes long — see its module header).
    const startOutcomes: LoopStartOutcome[] = await startPlannedLoopTickets({
      database,
      projectId: args.projectId,
      policy,
      tickets: created.map((c) => ({ issueId: c.issueId, issueNumber: c.issueNumber })),
      createWorkspace,
    });

    const converged = plan.converged ?? plan.units.length === 0;
    const { isDone, wasDone } = await persistConvergence({
      pluginSlug: args.pluginSlug,
      loopName: loop.name,
      projectId: args.projectId,
      converged,
      plannedUnits: plan.units.length,
      database,
    });

    // #357/#360 — one sentence per PLANNED unit, not per CREATED unit. The units this advance
    // found already ticketed are resolved from their real workspace/provisioning state, so the
    // report is identical whichever advance won the lock.
    const startNotices = [
      ...startOutcomes.map(describeLoopStartOutcome),
      ...await describeExistingUnits(
        skippedExisting.map((s) => ({ issueId: s.issueId, issueNumber: s.issueNumber })),
        database,
      ),
    ];
    const advancePayload: AdvanceEventPayload = {
      planned: plan.units.length,
      created,
      skippedExisting: skippedExisting.length,
      capped,
      converged,
      note: plan.note ?? null,
      gate: plan.gate ?? null,
      progress: plan.progress ?? null,
      checks: plan.checks ?? null,
      startNotices,
    };
    const priorGate = await recordAdvance({
      pluginSlug: args.pluginSlug,
      loopName: loop.name,
      projectId: args.projectId,
      payload: advancePayload,
      alsoConverged: isDone && !wasDone,
      note: plan.note ?? null,
      database,
    });

    // Gate-reached notification (#287): once per NEW gate id. The monitor re-plans a blocked
    // loop every cycle, so comparing against the PREVIOUS advance's gate is what keeps the
    // notification from firing on every poll while the human hasn't acted yet.
    if (plan.gate) {
      await notifyGateReached({
        eventKey: { pluginSlug: args.pluginSlug, loopName: loop.name, projectId: args.projectId },
        gate: plan.gate,
        priorGateId: priorGate?.id ?? null,
        pluginRowId: args.pluginRowId ?? null,
        pluginName: args.pluginName ?? args.pluginSlug,
        loopLabel: loop.label ?? loop.name,
        boardEvents,
        database,
        conciergeArgs: {
          projectId: args.projectId,
          pluginRowId: args.pluginRowId ?? null,
          pluginSlug: args.pluginSlug,
          pluginName: args.pluginName ?? args.pluginSlug,
          loopName: loop.name,
          loopLabel: loop.label ?? loop.name,
          gate: plan.gate,
          checks: plan.checks ?? null,
          note: plan.note ?? null,
          repoPath: args.repoPath,
          boardUrl,
        },
      });
    }

    return {
      loop: loop.name,
      converged,
      note: plan.note ?? null,
      planned: plan.units.length,
      created,
      skippedExisting,
      capped,
      startMode: policy.mode,
      startOutcomes,
      startNotices,
      warnings,
      gate: plan.gate ?? null,
      progress: plan.progress ?? null,
      checks: plan.checks ?? null,
    };
  }

  /** Newest-first timeline for one loop (#292). */
  async function loopEvents(pluginSlug: string, loopName: string, projectId: string, limit = 100) {
    return listPluginLoopEvents({ pluginSlug, loopName, projectId }, limit, database);
  }

  /** Apply a human's gate decision, then re-plan so the response carries the replacement state. */
  async function resolveGate(args: ResolveGateArgs) {
    return resolveLoopGate(args, { boardUrl, database, advanceLoop });
  }

  return { advanceLoop, loopStatuses, setLoopPaused, loopEvents, resolveGate };
}

export type PluginLoopEngine = ReturnType<typeof createPluginLoopEngine>;

/**
 * Persist the terminal verdict so the loop stops being replanned forever.
 *
 * **`converged` is a claim about the JOB, not about the currently-ready set.** Only a plan with NO
 * units AND an affirmative `converged` counts: `units: [], converged: false` is the documented
 * "blocked, not done" state and must keep polling, and `converged: true` WITH units is a planner
 * still handing out work. Any advance that plans units clears the flag, which is what makes a
 * manual "Advance now" the restart path. Guarded by `plugin-loop-invariants.test.ts`.
 */
async function persistConvergence(args: {
  pluginSlug: string;
  loopName: string;
  projectId: string;
  converged: boolean;
  plannedUnits: number;
  database: Database;
}): Promise<{ isDone: boolean; wasDone: boolean }> {
  const key = pluginLoopConvergedPreferenceKey(args.pluginSlug, args.loopName, args.projectId);
  const isDone = args.converged && args.plannedUnits === 0;
  // `parseBoolSetting` rather than a raw `=== "true"` (#947): this is a dynamic per-loop key
  // with no SETTINGS_REGISTRY entry, so it takes the `fallback = false` branch and the polarity
  // is identical to the comparison it replaces — the win is that the read says which rule it
  // follows instead of hard-coding one.
  const wasDone = parseBoolSetting(key, await getPreference(key, args.database));
  await setPreferenceChecked(args.database, [{ key, value: isDone ? "true" : "false" }]);
  return { isDone, wasDone };
}

/**
 * Timeline (#292): every advance leaves its result behind. The advance payload doubles as the
 * loop's current display state (gate/progress/checks) — see `plugin/loop-status.ts`.
 *
 * Returns the PREVIOUS advance's gate, which is what distinguishes a new gate from one the human
 * has not acted on yet (see `plugin/loop-gate-notify.ts`).
 */
async function recordAdvance(args: {
  pluginSlug: string;
  loopName: string;
  projectId: string;
  payload: AdvanceEventPayload;
  /** Write the once-per-loop `converged` event alongside it. */
  alsoConverged: boolean;
  note: string | null;
  database: Database;
}): Promise<AdvanceEventPayload["gate"] | null> {
  const eventKey = { pluginSlug: args.pluginSlug, loopName: args.loopName, projectId: args.projectId };
  const priorAdvanceRow = await latestPluginLoopEvent(eventKey, "advance", args.database);
  const priorAdvance = parseAdvancePayload(priorAdvanceRow);
  // #448 — a repeat of an unchanged no-op advance bumps the previous row's counter instead of
  // appending another identical one. See `collapseRepeatedNoOpAdvance` for the full contract.
  const collapsed = await collapseRepeatedNoOpAdvance(
    priorAdvanceRow, priorAdvance, args.payload, new Date().toISOString(), args.database,
  );
  if (!collapsed) {
    await insertPluginLoopEvent(eventKey, "advance", args.payload, args.database);
  }
  if (args.alsoConverged) {
    await insertPluginLoopEvent(eventKey, "converged", { note: args.note }, args.database);
  }
  return priorAdvance?.gate ?? null;
}
