import { parsePluginManifest } from "@agentic-kanban/shared/lib/plugin-manifest";
import { isPluginEnabledPreferenceKey } from "@agentic-kanban/shared/lib/dynamic-preference-keys";
import { parseBoolSetting } from "@agentic-kanban/shared/lib/settings-registry";
import type { Database } from "../db/index.js";
import { listPluginEnabledPreferences, listPluginRows } from "../repositories/plugins.repository.js";
import { getPluginService } from "./plugin.service.js";

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
  options: { allowProject: (projectId: string) => boolean; log?: (message: string) => void },
): Promise<number> {
  const log = options.log ?? ((message: string) => console.log(`[monitor] ${message}`));
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
      let hasLoops = false;
      try {
        hasLoops = (parsePluginManifest(row.manifestJson).loops ?? []).length > 0;
      } catch {
        continue; // broken cached manifest — never take the monitor down for it
      }
      if (!hasLoops) continue;

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
        if (loop.openTickets > 0) continue;
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
