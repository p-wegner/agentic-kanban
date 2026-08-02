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
 * **Opt-in by construction, with no extra preference.** A loop is only advanced
 * here if it already has at least one ticket, i.e. a human pressed "Advance"
 * once. So the monitor continues loops the user started and never starts one on
 * its own — and stopping a loop is just cancelling its open tickets and not
 * pressing Advance again. Convergence (the planner reporting no units) ends it.
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
