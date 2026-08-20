import { DEFAULT_PLUGIN_AUDIENCE, pluginSkillName } from "@agentic-kanban/shared/lib/plugin-manifest";
import type { Database } from "../db/index.js";
import { getAllPreferencesCached } from "../repositories/preferences.repository.js";
import { listEnabledPlugins, listEnabledPluginsByProjects, type PluginOwner } from "./plugin-enabled.js";
import { resolveStartPolicy } from "./start-policy.service.js";
import type { PluginLoopEngine, LoopStatus } from "./plugin-loop.service.js";

import { toPrefMap } from "@agentic-kanban/shared/lib/preference-map";
/**
 * "Everything the ENABLED plugins offer this project (or projects)" reads: the
 * combined views/loops/scripts/skills panel data and the cross-project loop-gate
 * sweep. Extracted from plugin.service.ts as its own cohesive module (god-module
 * ceiling) — the plugin service facade re-exposes these behind unchanged method names.
 */
export function createPluginProjectSurfaceOps(deps: {
  database: Database;
  requireProject: (projectId: string) => Promise<unknown>;
  loops: PluginLoopEngine;
  readManifestDrift: (row: { localPath: string; manifestJson: string }) => Promise<boolean>;
  getViewStatus: (pluginRowId: string, viewId: string, projectId: string) => Promise<Record<string, unknown>>;
}) {
  const { database, requireProject, loops, readManifestDrift, getViewStatus } = deps;

  /**
   * Everything the ENABLED plugins offer this project, in one read: the board's
   * Plugins panel renders views, loops, scripts and skills side by side, and
   * four round-trips for one panel would just be four chances to disagree.
   */
  async function listProjectSurface(projectId: string) {
    await requireProject(projectId);
    const views = [];
    const projectLoops = [];
    const scripts = [];
    const skills = [];
    /** Enabled plugins whose on-disk manifest is ahead of the one the board runs (#442). */
    const drifted: PluginOwner[] = [];
    for (const { row, manifest, owner } of await listEnabledPlugins(projectId, database)) {
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
    const policy = resolveStartPolicy(toPrefMap(prefs), projectId);
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
    const out = [];
    for (const { row, manifest, owner } of await listEnabledPlugins(projectId, database)) {
      try {
        for (const status of await loops.loopStatuses(manifest, row.pluginId, projectId)) {
          out.push({ ...owner, ...status });
        }
      } catch {
        /* skip plugins whose loop statuses cannot be read */
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
    const out = new Map<string, Array<LoopStatus & PluginOwner>>();
    if (projectIds.length === 0) return out;
    // The preference scan, the row read and every manifest parse happen ONCE for the
    // whole batch, not once per project (#552).
    const enabledByProject = await listEnabledPluginsByProjects(projectIds, database);
    await Promise.all(projectIds.map(async (projectId) => {
      const projectLoops: Array<LoopStatus & PluginOwner> = [];
      for (const { row, manifest, owner } of enabledByProject.get(projectId) ?? []) {
        try {
          for (const status of await loops.loopStatuses(manifest, row.pluginId, projectId, { includeCosts: false })) {
            projectLoops.push({ ...owner, ...status });
          }
        } catch { /* one plugin's broken loop state must not drop the project's other items */ }
      }
      out.set(projectId, projectLoops);
    }));
    return out;
  }

  return { listProjectSurface, listProjectLoops, listLoopSurfacesForProjects };
}
