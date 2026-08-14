import { parsePluginManifest } from "@agentic-kanban/shared/lib/plugin-manifest";
import { isPluginEnabledPreferenceKey } from "@agentic-kanban/shared/lib/dynamic-preference-keys";
import { parseBoolSetting } from "@agentic-kanban/shared/lib/settings-registry";
import type { Database } from "../db/index.js";
import { getWorkspaceGitCoordinates, listPluginEnabledPreferences, listPluginRows } from "../repositories/plugins.repository.js";
import { recoverStrandedAutoLand } from "./plugin-loop-autoland-recovery.js";
import { latestPluginLoopEvent } from "../repositories/plugin-loop-events.repository.js";
import { getPluginService } from "./plugin.service.js";

/**
 * How often this pass may retry a loop whose previous advance produced NOTHING (#372).
 * Falls back to the deterministic monitor's own default interval (`auto_monitor_interval`, 4 min)
 * when the caller passes none.
 */
export const DEFAULT_MIN_BLOCKED_ADVANCE_INTERVAL_MS = 4 * 60 * 1000;

/**
 * Was the loop's most recent advance a NO-OP — no tickets created and not converged?
 *
 * That is the "blocked, not done" state (an unresolved gate, or an upstream that is not finished),
 * and re-planning it changes nothing until something OUTSIDE this pass changes: a human resolves the
 * gate (`resolveGate` advances immediately) or a loop ticket merges (`advanceLoopAfterMergedIssue`
 * advances immediately). So a no-op advance may be retried on the monitor's own cadence and no
 * faster — see the rate limit in `advanceDuePluginLoops`.
 */
function lastAdvanceWasNoOp(payloadJson: string | null): boolean {
  if (!payloadJson) return false;
  try {
    const payload = JSON.parse(payloadJson) as { created?: unknown[]; converged?: boolean };
    return Array.isArray(payload.created) && payload.created.length === 0 && payload.converged !== true;
  } catch {
    return false; // unreadable payload — never let it suppress a real advance
  }
}

/**
 * Monitor pass that keeps board-owned plugin loops converging.
 *
 * A loop advances ONE round at a time: the previous round's tickets must all be
 * terminal before the planner is consulted again. That is what makes the loop
 * converge rather than pile up — each round's output is the state the next round
 * is planned from, so planning ahead of the work would plan against stale facts.
 *
 * **Opt-in by construction.** A loop is only advanced here if it already has at
 * least one ticket, i.e. a human pressed "Advance" once. So the monitor
 * continues loops the user started and never starts one on its own.
 *
 * **Two ways a loop stops here.**
 * - **Convergence** — an advance whose plan reported no units AND `converged: true` persists
 *   `plugin_loop_converged_<slug>_<loop>_<projectId>`, and this pass then skips the loop. Without
 *   that persistence a finished loop was replanned on EVERY cycle indefinitely (one planner
 *   subprocess per finished loop per cycle) and only a pause could stop it. A plan reporting
 *   `units: [], converged: false` is the "blocked, not done" case and deliberately keeps polling.
 * - **Explicit pause** — a human stops the loop via
 *   `plugin_loop_paused_<slug>_<loop>_<projectId>` (Pause/Resume in the loop pane); this pass
 *   skips it entirely, leaving its open tickets alone.
 *
 * Neither flag is consulted by a manual "Advance now", so replanning a converged loop (or a
 * paused one) is always one deliberate click away.
 */
export async function advanceDuePluginLoops(
  database: Database,
  options: {
    allowProject: (projectId: string) => boolean;
    log?: (message: string) => void;
    /** Minimum spacing between two NO-OP advances of the SAME loop (#372). */
    minBlockedAdvanceIntervalMs?: number;
    /** Injectable clock for tests. */
    now?: number;
    /**
     * Land a stranded `autoLand` unit (#444). Injected rather than imported so this module stays
     * free of the merge machinery — and so a caller that does not pass it gets the previous
     * behaviour exactly (detect and report, never land).
     */
    land?: (workspaceId: string) => Promise<void>;
    /** Minimum age of a stall before recovery will land it (#444). */
    autoLandRecoveryMinAgeMs?: number;
  },
): Promise<number> {
  const log = options.log ?? ((message: string) => console.log(`[monitor] ${message}`));
  const nowMs = options.now ?? Date.now();
  const minBlockedIntervalMs = options.minBlockedAdvanceIntervalMs ?? DEFAULT_MIN_BLOCKED_ADVANCE_INTERVAL_MS;
  const service = getPluginService(database);

  // plugin_enabled_<slug>_<projectId> — the projectId is the fixed-length uuid tail.
  const enabled = new Map<string, Set<string>>();
  for (const row of await listPluginEnabledPreferences(database)) {
    // plugin_enabled_* has no SETTINGS_REGISTRY entry (dynamic per-plugin-per-project key),
    // so parseBoolSetting falls back to the explicit `false` default below — same polarity
    // as the raw `!== "true"` check this replaces, but routed through the #947 accessor.
    if (!isPluginEnabledPreferenceKey(row.key) || !parseBoolSetting(row.key, row.value, false)) continue;
    const rest = row.key.slice("plugin_enabled_".length);
    const projectId = rest.slice(-36);
    if (!options.allowProject(projectId)) continue;
    if (!enabled.has(projectId)) enabled.set(projectId, new Set());
    enabled.get(projectId)!.add(rest.slice(0, -37));
  }
  if (enabled.size === 0) return 0;

  const pluginRows = await listPluginRows(database);
  let advanced = 0;

  for (const [projectId, slugs] of enabled) {
    for (const row of pluginRows) {
      if (!slugs.has(row.pluginId)) continue;
      let loopDefs: { name: string; autoLand?: boolean }[] = [];
      try {
        loopDefs = parsePluginManifest(row.manifestJson).loops ?? [];
      } catch {
        continue; // broken cached manifest — never take the monitor down for it
      }
      if (loopDefs.length === 0) continue;

      let statuses;
      try {
        statuses = await service.listLoops(row.id, projectId);
      } catch {
        continue; // e.g. the project was deleted mid-cycle
      }
      for (const loop of statuses) {
        // Explicitly paused by a human — the only direct way to stop a converging
        // loop; a manual "Advance now" from the UI still works while paused.
        if (loop.paused) continue;
        // Already reported the JOB done. Re-running its planner every cycle bought nothing and
        // cost a subprocess per finished loop per cycle.
        if (loop.converged) continue;
        // Not started by a human yet, or the current round is still running.
        if (loop.closedTickets === 0 && loop.openTickets === 0) continue;
        // #444 — a finished-but-unlanded unit on an autoLand loop. Checked BEFORE the
        // still-running bail below, because that is exactly the state it presents as: the ticket
        // is Done/In Review, so it counts as open, and the loop can never replan while it does.
        // Nothing here starts an agent; the worst case is a merge the gate then refuses.
        if (options.land && loop.awaitingMerge) {
          const autoLand = loopDefs.find((def) => def.name === loop.name)?.autoLand === true;
          const landed = await recoverStrandedAutoLand(
            loop.awaitingMerge,
            { autoLand, nowMs, minAgeMs: options.autoLandRecoveryMinAgeMs },
            {
              workspace: await getWorkspaceGitCoordinates(loop.awaitingMerge.workspaceId, database),
              land: options.land,
              log,
            },
          );
          // The merge tail advances the loop itself (#298), so this cycle is done with it either
          // way: a landed unit replans from the merge, an unlanded one is unchanged.
          if (landed) continue;
        }
        if (loop.openTickets > 0) continue;
        // Interval gating (#372). This pass runs once per monitor CYCLE, and cycles are
        // event-triggered (a board mutation fires one after a 1.5s debounce) — not once per
        // `auto_monitor_interval`. So on a busy board a loop that is blocked on a human gate was
        // re-planned at the cycle cadence: MEASURED median 91s between advances for the same loop
        // with the interval set to 240s (500 no-op advances per loop in ~20h, one planner
        // subprocess each). The productive paths are unaffected — `resolveGate` and
        // `advanceLoopAfterMergedIssue` advance the loop directly the moment its state really
        // changes; only the no-op RETRY is spaced out to the configured monitor interval.
        if (minBlockedIntervalMs > 0) {
          const lastAdvance = await latestPluginLoopEvent(
            { pluginSlug: row.pluginId, loopName: loop.name, projectId },
            "advance",
            database,
          ).catch(() => null);
          if (lastAdvance && lastAdvanceWasNoOp(lastAdvance.payloadJson)) {
            const age = nowMs - new Date(lastAdvance.createdAt).getTime();
            if (Number.isFinite(age) && age >= 0 && age < minBlockedIntervalMs) continue;
          }
        }
        try {
          const result = await service.advanceLoop(row.id, loop.name, projectId);
          if (result.created.length > 0) {
            advanced++;
            log(`plugin loop ${row.pluginId}:${loop.name} advanced — ${result.created.length} ticket(s) created`);
          } else if (result.converged) {
            log(`plugin loop ${row.pluginId}:${loop.name} converged${result.note ? ` — ${result.note}` : ""}`);
          }
        } catch (err) {
          log(`plugin loop ${row.pluginId}:${loop.name} advance failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }
  }
  return advanced;
}
