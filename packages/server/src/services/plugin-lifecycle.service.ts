import { createHash, randomUUID } from "node:crypto";
import { basename, resolve, join } from "node:path";
import { existsSync, mkdirSync, statSync } from "node:fs";
import { gitExec, gitExecOrThrow } from "@agentic-kanban/shared/lib/git-exec";
import { pluginEnabledPreferenceKey, type PluginManifest } from "@agentic-kanban/shared/lib/plugin-manifest";
import { setPreferenceChecked } from "@agentic-kanban/shared/lib/checked-preference-write";
import { isPluginEnabledPreferenceKey } from "@agentic-kanban/shared/lib/dynamic-preference-keys";
import type { Database } from "../db/index.js";
import {
  deletePluginRow,
  getPluginRowById,
  listPluginEnabledPreferences,
  upsertPluginRow,
  type PluginRow,
} from "../repositories/plugins.repository.js";
import { pluginsHomeDir, looksLikeGitUrl, readManifestFromDir } from "./plugin-fs.js";
import { normalizeGitUrl } from "./plugin-marketplace.js";
import { stopPluginViews } from "./plugin-views.service.js";
import { deletePluginViewProcessesForPlugin } from "../repositories/plugin-view-processes.repository.js";
import { PluginError } from "./plugin-errors.js";
import type { EnableReport } from "./plugin-enablement.service.js";

export interface PluginUpdateResult {
  row: PluginRow;
  /** Whether a `git pull` ran (only board-managed clones, i.e. rows with a sourceUrl). */
  pulled: boolean;
  /** Whether the pull actually moved HEAD. */
  headChanged: boolean;
  previousVersion: string | null;
  version: string | null;
  /** Running view servers of this plugin killed because they executed pre-update code. */
  viewsStopped: number;
  /**
   * Skills re-materialized into each project that has this plugin enabled (#443).
   * An update can ADD or RENAME a skill dir, and only `enableForProject` used to fan
   * skills out — so a newly declared skill appeared in the panel with no bundle behind it.
   */
  skillsRefreshed: Array<{ projectId: string; skills: EnableReport["skills"]; warnings: string[] }>;
}

/**
 * Install/update/remove of a plugin ROW (as opposed to per-project enablement, which
 * lives in plugin-enablement.service.ts). Extracted from plugin.service.ts as its own
 * cohesive module (god-module ceiling) — the plugin service facade re-exposes these
 * behind unchanged method names.
 */
export function createPluginLifecycleOps(deps: {
  database: Database;
  requireProject: (projectId: string) => Promise<{ id: string; repoPath: string; name: string }>;
  enabledSlugsByProject: () => Promise<Map<string, Set<string>>>;
  fanOutSkills: (plugin: PluginRow & { manifest: PluginManifest }, repoPath: string, report: EnableReport) => void;
}) {
  const { database, requireProject, enabledSlugsByProject, fanOutSkills } = deps;

  /**
   * Where a git-sourced plugin is cloned. Keyed by a hash of the NORMALIZED url, not by the
   * repo's basename: `github.com/a/tools` and `gitlab.com/b/tools` both wanted
   * `<plugins home>/tools`, and since the clone is skipped when the directory exists, the second
   * install silently registered the FIRST checkout under its own `sourceUrl` — a plugin serving
   * another repo's code.
   *
   * A legacy basename-only directory is still reused when its `origin` is the same remote, so
   * plugins installed before this change are not re-cloned. Any existing directory whose origin
   * disagrees is refused rather than adopted.
   */
  async function resolveCloneDir(source: string): Promise<string> {
    const repoName = (basename(source).replace(/\.git$/i, "") || "plugin").toLowerCase()
      .replace(/[^a-z0-9._-]+/g, "-");
    const legacy = join(pluginsHomeDir(), repoName);
    if (existsSync(legacy) && await cloneMatchesRemote(legacy, source)) return legacy;
    const digest = createHash("sha1").update(normalizeGitUrl(source)).digest("hex").slice(0, 8);
    const keyed = join(pluginsHomeDir(), `${repoName}-${digest}`);
    if (existsSync(keyed) && !(await cloneMatchesRemote(keyed, source))) {
      throw new PluginError(
        `${keyed} already holds a checkout of a different remote — remove it or install from a local directory`,
        "CONFLICT",
      );
    }
    return keyed;
  }

  /** True when `dir` is a git checkout whose origin is (the normalized form of) `source`. */
  async function cloneMatchesRemote(dir: string, source: string): Promise<boolean> {
    const result = await gitExec(["remote", "get-url", "origin"], { cwd: dir });
    if (result.code !== 0) return false;
    return normalizeGitUrl(result.stdout) === normalizeGitUrl(source);
  }

  async function installPlugin(input: { source: string }): Promise<PluginRow> {
    const source = typeof input.source === "string" ? input.source.trim() : "";
    if (!source) throw new PluginError("source is required", "BAD_REQUEST");

    let localPath: string;
    let sourceUrl: string | null = null;
    if (existsSync(source) && statSync(source).isDirectory()) {
      localPath = resolve(source);
    } else if (looksLikeGitUrl(source)) {
      sourceUrl = source;
      localPath = await resolveCloneDir(source);
      if (!existsSync(localPath)) {
        mkdirSync(pluginsHomeDir(), { recursive: true });
        await gitExecOrThrow(["clone", "--depth", "1", source, localPath], {});
      }
    } else {
      throw new PluginError(
        `source must be an existing local directory or a git URL (got "${source}")`,
        "BAD_REQUEST",
      );
    }

    const { manifest, raw } = readManifestFromDir(localPath);
    return upsertPluginRow(
      {
        id: randomUUID(),
        pluginId: manifest.id,
        name: manifest.name,
        sourceUrl,
        localPath,
        version: manifest.version ?? null,
        manifestJson: raw,
      },
      database,
    );
  }

  /**
   * Refresh an installed plugin in place: `git pull --ff-only` for a board-managed clone
   * (a row with a `sourceUrl`), then re-read the manifest into the row. A plugin installed
   * from a local directory is the USER'S checkout — it is never pulled, only re-read, so
   * "Update" doubles as "pick up my local manifest edits". When the pull actually moved
   * HEAD, this plugin's running view servers are stopped: they still execute the old code,
   * and a silently stale dashboard is worse than a one-click restart.
   */
  async function updatePlugin(id: string): Promise<PluginUpdateResult> {
    const row = await getPluginRowById(id, database);
    if (!row) throw new PluginError("Plugin not found", "NOT_FOUND");
    if (!existsSync(row.localPath)) {
      throw new PluginError(`Plugin checkout no longer exists at ${row.localPath}`, "BAD_REQUEST");
    }

    let pulled = false;
    let headChanged = false;
    if (row.sourceUrl) {
      const before = (await gitExecOrThrow(["rev-parse", "HEAD"], { cwd: row.localPath })).trim();
      // ff-only: an update must never merge or rebase a plugin checkout; divergence
      // (e.g. a hand-edited clone) surfaces as an error instead of a surprise merge.
      await gitExecOrThrow(["pull", "--ff-only"], { cwd: row.localPath });
      const after = (await gitExecOrThrow(["rev-parse", "HEAD"], { cwd: row.localPath })).trim();
      pulled = true;
      headChanged = before !== after;
    }

    const { manifest, raw } = readManifestFromDir(row.localPath);
    if (manifest.id !== row.pluginId) {
      throw new PluginError(
        `Manifest id changed upstream ("${row.pluginId}" → "${manifest.id}"). Uninstall and reinstall to adopt the new id — per-project enablement is keyed by it.`,
        "BAD_REQUEST",
      );
    }

    const viewsStopped = headChanged ? stopPluginViews(row.id) : 0;
    if (headChanged) await deletePluginViewProcessesForPlugin(row.id, undefined, database);

    const updated = await upsertPluginRow(
      {
        id: row.id,
        pluginId: row.pluginId,
        name: manifest.name,
        sourceUrl: row.sourceUrl,
        localPath: row.localPath,
        version: manifest.version ?? null,
        manifestJson: raw,
      },
      database,
    );
    // #443: the manifest that just landed may declare a skill the enabled projects have no
    // bundle for. `enableForProject` was the ONLY skill fan-out, so a rename (pm-pipeline's
    // `pm-pipeline-operate` → `pm-round`) left the panel offering a skill whose directory does
    // not exist in the project — `copySkillToWorktree` then returns false silently and the
    // ticket launches with the skill NAME in its prose and nothing to run (#204's failure
    // mode, through a door update opened). Re-running the fan-out is idempotent: an already
    // materialized skill reports `skipped-existing`.
    const skillsRefreshed: PluginUpdateResult["skillsRefreshed"] = [];
    const enabledByProject = await enabledSlugsByProject();
    for (const [projectId, slugs] of enabledByProject) {
      if (!slugs.has(row.pluginId)) continue;
      try {
        const project = await requireProject(projectId);
        const report: EnableReport = {
          prefKey: pluginEnabledPreferenceKey(row.pluginId, projectId),
          skills: [], scaffoldWritten: false, scaffoldPlaceholders: 0, warnings: [],
        };
        fanOutSkills({ ...updated, manifest }, project.repoPath, report);
        skillsRefreshed.push({ projectId, skills: report.skills, warnings: report.warnings });
      } catch (err) {
        // A project whose repo has gone missing must not fail the update itself.
        skillsRefreshed.push({
          projectId, skills: [],
          warnings: [`skill refresh skipped: ${err instanceof Error ? err.message : String(err)}`],
        });
      }
    }

    return {
      row: updated,
      pulled,
      headChanged,
      previousVersion: row.version ?? null,
      version: updated.version ?? null,
      viewsStopped,
      skillsRefreshed,
    };
  }

  /** Delete the row + running views. Never deletes cloned files on disk. */
  async function removePlugin(id: string): Promise<void> {
    const row = await getPluginRowById(id, database);
    if (!row) throw new PluginError("Plugin not found", "NOT_FOUND");
    stopPluginViews(id);
    await deletePluginViewProcessesForPlugin(id, undefined, database);
    // Disable everywhere: flip every plugin_enabled_<slug>_* pref to "false" via the
    // checked write (skill junctions/scaffolds stay — the row is gone, the files inert).
    const prefs = await listPluginEnabledPreferences(database);
    const entries = prefs
      .filter((p) => isPluginEnabledPreferenceKey(p.key) && p.key.startsWith(`plugin_enabled_${row.pluginId}_`))
      .map((p) => ({ key: p.key, value: "false" }));
    if (entries.length > 0) await setPreferenceChecked(database, entries);
    await deletePluginRow(id, database);
  }

  return { installPlugin, updatePlugin, removePlugin };
}
