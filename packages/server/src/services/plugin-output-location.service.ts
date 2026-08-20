import {
  DEFAULT_PLUGIN_OUTPUT_LOCATION,
  PLUGIN_OUTPUT_LOCATIONS,
  isPluginOutputLocation,
  pluginOutputLocationPreferenceKey,
  pluginSidecarRepoName,
  type PluginManifest,
  type PluginOutputLocation,
} from "@agentic-kanban/shared/lib/plugin-manifest";
import { setPreferenceChecked } from "@agentic-kanban/shared/lib/checked-preference-write";
import type { Database } from "../db/index.js";
import { getPreference } from "../repositories/preferences.repository.js";
import { insertProjectRepo, listProjectRepos } from "../repositories/repo.repository.js";
import type { PluginRow } from "../repositories/plugins.repository.js";
import { createSiblingRepoDir } from "./project-repos.service.js";
import { detectRepoInfo } from "./git-info.service.js";
import { PluginError } from "./plugin-errors.js";

/**
 * Output-location concern of the plugin service: where a plugin's
 * scaffold/script/loop output goes for a project — the project's leading repo
 * (default) or a dedicated sidecar repo created on first use. Extracted from
 * plugin.service.ts as its own cohesive module (god-module ceiling); the plugin
 * service facade re-exposes these behind unchanged method names.
 */
export function createPluginOutputLocationOps(deps: {
  database: Database;
  requirePlugin: (id: string) => Promise<PluginRow & { manifest: PluginManifest }>;
  requireProject: (projectId: string) => Promise<{ id: string; repoPath: string }>;
}) {
  const { database, requirePlugin, requireProject } = deps;

  async function readOutputLocationPref(pluginSlug: string, projectId: string): Promise<PluginOutputLocation> {
    const raw = await getPreference(pluginOutputLocationPreferenceKey(pluginSlug, projectId), database);
    return isPluginOutputLocation(raw) ? raw : DEFAULT_PLUGIN_OUTPUT_LOCATION;
  }

  /** Find (never creates) the sidecar repo row for a plugin, by its naming convention. */
  async function findSidecarRepo(pluginSlug: string, projectId: string) {
    const sidecarName = pluginSidecarRepoName(pluginSlug);
    const siblings = await listProjectRepos(projectId, database);
    return siblings.find((r) => (r.name ?? "") === sidecarName) ?? null;
  }

  /**
   * Where this plugin's scaffold/script/loop output goes for a project — the
   * project's leading repo (default), or a dedicated sidecar repo, CREATED on
   * first use if `"sidecar"` is selected and no such repo exists yet.
   */
  async function resolveOutputRepoPath(
    plugin: PluginRow & { manifest: PluginManifest },
    project: { id: string; repoPath: string },
  ): Promise<string> {
    const location = await readOutputLocationPref(plugin.pluginId, project.id);
    if (location === "leading") return project.repoPath;

    const existing = await findSidecarRepo(plugin.pluginId, project.id);
    if (existing) return existing.path;

    const sidecarName = pluginSidecarRepoName(plugin.pluginId);
    const path = await createSiblingRepoDir(database, project.id, { name: sidecarName, generateReadme: true });
    const repoInfo = await detectRepoInfo(path);
    await insertProjectRepo(
      { projectId: project.id, path: repoInfo.repoPath, name: sidecarName, defaultBranch: repoInfo.defaultBranch },
      database,
    );
    return repoInfo.repoPath;
  }

  /**
   * The output repo path as it stands, CREATING NOTHING — for read-only consumers (the butler
   * prompt) where materializing a sidecar repo as a side effect would be wrong. A chosen-but-
   * not-yet-created sidecar falls back to the leading repo, which is the best available answer.
   */
  async function peekOutputRepoPath(pluginSlug: string, project: { id: string; repoPath: string }): Promise<string> {
    const location = await readOutputLocationPref(pluginSlug, project.id);
    if (location === "leading") return project.repoPath;
    return (await findSidecarRepo(pluginSlug, project.id))?.path ?? project.repoPath;
  }

  /** Current output-location choice + its resolved repo path (`null` = sidecar chosen but not created yet). */
  async function getOutputLocation(pluginRowId: string, projectId: string) {
    const plugin = await requirePlugin(pluginRowId);
    const project = await requireProject(projectId);
    const location = await readOutputLocationPref(plugin.pluginId, projectId);
    const repoPath = location === "leading" ? project.repoPath : (await findSidecarRepo(plugin.pluginId, projectId))?.path ?? null;
    return { location, repoPath, sidecarRepoName: pluginSidecarRepoName(plugin.pluginId) };
  }

  /** Set the output-location choice and eagerly materialize a sidecar repo if picked. */
  async function setOutputLocation(pluginRowId: string, projectId: string, location: string) {
    if (!isPluginOutputLocation(location)) {
      throw new PluginError(`location must be one of: ${PLUGIN_OUTPUT_LOCATIONS.join(", ")}`, "BAD_REQUEST");
    }
    const plugin = await requirePlugin(pluginRowId);
    const project = await requireProject(projectId);
    const prefKey = pluginOutputLocationPreferenceKey(plugin.pluginId, projectId);
    await setPreferenceChecked(database, [{ key: prefKey, value: location }]);
    const repoPath = await resolveOutputRepoPath(plugin, project);
    return { location, repoPath, sidecarRepoName: pluginSidecarRepoName(plugin.pluginId) };
  }

  return {
    readOutputLocationPref,
    findSidecarRepo,
    resolveOutputRepoPath,
    peekOutputRepoPath,
    getOutputLocation,
    setOutputLocation,
  };
}
