import { DEFAULT_PLUGIN_AUDIENCE, parsePluginManifest, pluginSkillName, type PluginManifest } from "@agentic-kanban/shared/lib/plugin-manifest";
import type { Database } from "../db/index.js";
import { listPluginRows, type PluginRow } from "../repositories/plugins.repository.js";
import { getAllPreferencesCached } from "../repositories/preferences.repository.js";
import { resolveStartPolicy } from "./start-policy.service.js";
import type { PluginLoopEngine, LoopStatus } from "./plugin-loop.service.js";

/**
 * "Everything the ENABLED plugins offer this project (or projects)" reads: the
 * combined views/loops/scripts/skills panel data and the cross-project loop-gate
 * sweep. Extracted from plugin.service.ts as its own cohesive module (god-module
 * ceiling) — the plugin service facade re-exposes these behind unchanged method names.
 */
export function createPluginProjectSurfaceOps(deps: {
  database: Database;
  requireProject: (projectId: string) => Promise<unknown>;
  enabledSlugsByProject: () => Promise<Map<string, Set<string>>>;
  loops: PluginLoopEngine;
  readManifestDrift: (row: { localPath: string; manifestJson: string }) => Promise<boolean>;
  getViewStatus: (pluginRowId: string, viewId: string, projectId: string) => Promise<Record<string, unknown>>;
}) {
  const { database, requireProject, enabledSlugsByProject, loops, readManifestDrift, getViewStatus } = deps;

  /**
   * Everything the ENABLED plugins offer this project, in one read: the board's
   * Plugins panel renders views, loops, scripts and skills side by side, and
   * four round-trips for one panel would just be four chances to disagree.
   */
  async function listProjectSurface(projectId: string) {
    await requireProject(projectId);
    const enabled = (await enabledSlugsByProject()).get(projectId) ?? new Set<string>();
    const views = [];
    const projectLoops = [];
    const scripts = [];
    const skills = [];
    /** Enabled plugins whose on-disk manifest is ahead of the one the board runs (#442). */
    const drifted: Array<{ pluginId: string; pluginSlug: string; pluginName: string }> = [];
    for (const row of await listPluginRows(database)) {
      if (!enabled.has(row.pluginId)) continue;
      let manifest: PluginManifest;
      try {
        manifest = parsePluginManifest(row.manifestJson);
      } catch {
        continue; // a broken cached manifest must not blank the whole panel
      }
      const owner = { pluginId: row.id, pluginSlug: row.pluginId, pluginName: row.name };
      if (await readManifestDrift(row)) drifted.push(owner);
      for (const view of manifest.views ?? []) {
        views.push({
          ...owner,
          id: view.id,
          label: view.label,
          kind: view.kind,
          description: view.description ?? null,
          // #456 — resolved here, so every consumer sees the same default and a manifest
          // written before the field existed reads as `operator` rather than as unknown.
          audience: view.audience ?? DEFAULT_PLUGIN_AUDIENCE,
          ...(await getViewStatus(row.id, view.id, projectId)),
        });
      }
      // Cost rollup (#294) now lives inside `loopStatuses` (default `includeCosts: true`),
      // so the panel's "$X so far" arrives on the status itself.
      for (const status of await loops.loopStatuses(manifest, row.pluginId, projectId)) {
        projectLoops.push({ ...owner, ...status });
      }
      for (const script of manifest.scripts ?? []) {
        scripts.push({
          ...owner,
          name: script.name,
          label: script.label ?? script.name,
          description: script.description ?? null,
          command: script.command,
          audience: script.audience ?? DEFAULT_PLUGIN_AUDIENCE,
        });
      }
      for (const skill of manifest.skills ?? []) {
        const name = pluginSkillName(skill.dir);
        // `workflow` travels to the UI so the launcher can SEE which workflow the plugin
        // chose for this skill, and change it, instead of discovering it after the fact.
        skills.push({
          ...owner,
          name,
          description: skill.description ?? null,
          workflow: skill.workflow ?? null,
          audience: skill.audience ?? DEFAULT_PLUGIN_AUDIENCE,
        });
      }
    }
    // Start policy (#293): under `manual` the monitor never runs the planner, which is
    // indistinguishable from convergence unless the panel says so explicitly.
    // #402's short-TTL cache — this surface is polled, so the raw full-table scan added up.
    const prefs = await getAllPreferencesCached(database);
    const policy = resolveStartPolicy(new Map(prefs.map((p) => [p.key, p.value])), projectId);
    return {
      views,
      loops: projectLoops,
      scripts,
      skills,
      drifted,
      startPolicy: { mode: policy.mode, autoStartUnblocked: policy.autoStartUnblocked },
    };
  }

  /** Flat list of the ENABLED plugins' loops for a project (the board Plugins panel). */
  async function listProjectLoops(projectId: string) {
    await requireProject(projectId);
    const enabled = (await enabledSlugsByProject()).get(projectId) ?? new Set<string>();
    const out = [];
    for (const row of await listPluginRows(database)) {
      if (!enabled.has(row.pluginId)) continue;
      try {
        const manifest = parsePluginManifest(row.manifestJson);
        for (const status of await loops.loopStatuses(manifest, row.pluginId, projectId)) {
          out.push({ pluginId: row.id, pluginSlug: row.pluginId, pluginName: row.name, ...status });
        }
      } catch {
        /* skip plugins with a broken cached manifest */
      }
    }
    return out;
  }

  /**
   * The enabled plugins' LOOP statuses for MANY projects in one sweep — built for the
   * cross-project inbox poll (2026-08-11 perf audit). `listProjectSurface` re-read the
   * plugin rows, re-parsed every manifest and re-scanned the enabled-prefs table PER
   * PROJECT per poll; here those per-poll invariants are hoisted and shared, views/
   * scripts/skills are skipped (the inbox reads only gates), and the cost rollup is
   * skipped via `includeCosts: false`. Per-plugin errors are swallowed so one broken
   * plugin never empties another project's inbox.
   */
  async function listLoopSurfacesForProjects(projectIds: string[]) {
    const out = new Map<string, Array<LoopStatus & { pluginId: string; pluginSlug: string; pluginName: string }>>();
    if (projectIds.length === 0) return out;
    const enabledMap = await enabledSlugsByProject();
    // Parse each installed plugin's manifest ONCE, not once per project.
    const parsedRows: Array<{ row: PluginRow; manifest: PluginManifest }> = [];
    for (const row of await listPluginRows(database)) {
      try {
        parsedRows.push({ row, manifest: parsePluginManifest(row.manifestJson) });
      } catch { /* a broken cached manifest must not blank every project's inbox */ }
    }
    await Promise.all(projectIds.map(async (projectId) => {
      const enabled = enabledMap.get(projectId) ?? new Set<string>();
      const projectLoops: Array<LoopStatus & { pluginId: string; pluginSlug: string; pluginName: string }> = [];
      for (const { row, manifest } of parsedRows) {
        if (!enabled.has(row.pluginId)) continue;
        try {
          for (const status of await loops.loopStatuses(manifest, row.pluginId, projectId, { includeCosts: false })) {
            projectLoops.push({ pluginId: row.id, pluginSlug: row.pluginId, pluginName: row.name, ...status });
          }
        } catch { /* one plugin's broken loop state must not drop the project's other items */ }
      }
      out.set(projectId, projectLoops);
    }));
    return out;
  }

  return { listProjectSurface, listProjectLoops, listLoopSurfacesForProjects };
}
