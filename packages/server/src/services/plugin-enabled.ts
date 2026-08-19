/**
 * The one iterator over "which plugins are ENABLED for this project, and what do
 * their manifests say" (#552).
 *
 * The loop — enabled slugs → every installed row → skip the ones not enabled →
 * `parsePluginManifest` in a try/catch that SKIPS on failure → project
 * `{pluginId, pluginSlug, pluginName}` — was hand-written in ten places
 * (plugin.service, plugin-project-surface ×3, plugin-views, plugin-loop-monitor,
 * workspace-provision ×3). Each copy re-decided what a broken cached manifest
 * means; the rule is that it must never blank a panel, never take the monitor
 * down, and never fail a workspace creation, so it is decided here once.
 *
 * `listPluginRows` returns every INSTALLED plugin, so the per-project filter must
 * never become "one DB query per installed plugin" again — the enabled slugs come
 * from a single preference scan (`enabledPluginSlugsByProject`) which the batch
 * variant shares across projects.
 */
import { isPluginEnabledPreferenceKey } from "@agentic-kanban/shared/lib/dynamic-preference-keys";
import { parseBoolSetting } from "@agentic-kanban/shared/lib/settings-registry";
import { parsePluginManifest, type PluginManifest } from "@agentic-kanban/shared/lib/plugin-manifest";
import { db, type Database } from "../db/index.js";
import { getPluginRowBySlug, listPluginEnabledPreferences, listPluginRows, type PluginRow } from "../repositories/plugins.repository.js";

/** How every plugin-owned row identifies its owner to the client. */
export interface PluginOwner {
  pluginId: string;
  pluginSlug: string;
  pluginName: string;
}

export interface EnabledPlugin {
  row: PluginRow;
  manifest: PluginManifest;
  owner: PluginOwner;
}

export function pluginOwner(row: PluginRow): PluginOwner {
  return { pluginId: row.id, pluginSlug: row.pluginId, pluginName: row.name };
}

/**
 * `plugin_enabled_<slug>_<projectId>` for every project in ONE preference scan.
 * The projectId is the fixed-length uuid tail, so the slug is everything before it.
 *
 * `plugin_enabled_*` has no SETTINGS_REGISTRY entry (dynamic per-plugin-per-project
 * key), so `parseBoolSetting` falls back to the explicit `false` default — enablement
 * is opt-in, exactly as `isPluginEnabledForProject` decides it for the single-row read.
 */
export async function enabledPluginSlugsByProject(database: Database = db): Promise<Map<string, Set<string>>> {
  const map = new Map<string, Set<string>>();
  for (const row of await listPluginEnabledPreferences(database)) {
    if (!isPluginEnabledPreferenceKey(row.key) || !parseBoolSetting(row.key, row.value, false)) continue;
    const rest = row.key.slice("plugin_enabled_".length);
    const projectId = rest.slice(-36);
    const slug = rest.slice(0, -37);
    if (!map.has(projectId)) map.set(projectId, new Set());
    map.get(projectId)!.add(slug);
  }
  return map;
}

function parseEnabled(rows: PluginRow[], slugs: Set<string>): EnabledPlugin[] {
  const out: EnabledPlugin[] = [];
  for (const row of rows) {
    if (!slugs.has(row.pluginId)) continue;
    let manifest: PluginManifest;
    try {
      manifest = parsePluginManifest(row.manifestJson);
    } catch {
      continue; // a broken cached manifest must not blank the panel / stop the sweep
    }
    out.push({ row, manifest, owner: pluginOwner(row) });
  }
  return out;
}

/** Every plugin enabled for one project, manifest already parsed (broken ones skipped). */
export async function listEnabledPlugins(projectId: string, database: Database = db): Promise<EnabledPlugin[]> {
  const slugs = (await enabledPluginSlugsByProject(database)).get(projectId);
  if (!slugs || slugs.size === 0) return [];
  return parseEnabled(await listPluginRows(database), slugs);
}

/**
 * The same, for MANY projects in one sweep — the preference scan, the row read and
 * each manifest parse happen ONCE, not once per project (cross-project inbox poll).
 */
export async function listEnabledPluginsByProjects(
  projectIds: string[],
  database: Database = db,
): Promise<Map<string, EnabledPlugin[]>> {
  const out = new Map<string, EnabledPlugin[]>();
  if (projectIds.length === 0) return out;
  const enabledMap = await enabledPluginSlugsByProject(database);
  const rows = await listPluginRows(database);
  const parsed = parseEnabled(rows, new Set(rows.map((r) => r.pluginId)));
  for (const projectId of projectIds) {
    const slugs = enabledMap.get(projectId);
    out.set(projectId, slugs ? parsed.filter((e) => slugs.has(e.row.pluginId)) : []);
  }
  return out;
}

/** One enabled plugin by its manifest slug — null when not installed, not enabled, or broken. */
export async function getEnabledPluginBySlug(
  pluginSlug: string,
  projectId: string,
  database: Database = db,
): Promise<EnabledPlugin | null> {
  const slugs = (await enabledPluginSlugsByProject(database)).get(projectId);
  if (!slugs?.has(pluginSlug)) return null;
  const row = await getPluginRowBySlug(pluginSlug, database);
  if (!row) return null;
  return parseEnabled([row], new Set([pluginSlug]))[0] ?? null;
}
