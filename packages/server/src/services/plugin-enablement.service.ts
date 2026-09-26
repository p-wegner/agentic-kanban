import { existsSync, mkdirSync, symlinkSync, cpSync } from "node:fs";
import { join } from "node:path";
import { skillDirOf, skillsDirOf } from "@agentic-kanban/shared/lib/agent-skill-files";
import { setPreferenceChecked } from "@agentic-kanban/shared/lib/checked-preference-write";
import {
  pluginEnabledPreferenceKey,
  pluginSkillName,
  type PluginManifest,
} from "@agentic-kanban/shared/lib/plugin-manifest";
import {
  resolvePluginSkillListing,
  parsePluginSkillListingOverrides,
  pluginSkillListingPreferenceKey,
  isSkillListing,
  type SkillListing,
} from "@agentic-kanban/shared/lib/plugin-skill-listing";
import { toPrefMap } from "@agentic-kanban/shared/lib/preference-map";
import { getJson } from "@agentic-kanban/shared/lib/settings-registry";
import type { Database } from "../db/index.js";
import type { PluginRow } from "../repositories/plugins.repository.js";
import { getAllPreferences } from "../repositories/preferences.repository.js";
import { resolveInside, addToGitInfoExclude, isLinkPath, removeLink } from "./plugin-fs.js";
import { fanOutScaffold } from "./plugin-scaffold.js";
import { syncPluginSkillOverrides } from "./plugin-skill-overrides.service.js";
import { stopPluginViews } from "./plugin-views.service.js";
import { deletePluginViewProcessesForPlugin } from "../repositories/plugin-view-processes.repository.js";
import { applySkillListingOverrides, removeSkillListingOverrides } from "./plugin-skill-listing-settings.js";
import { errorMessage } from "@agentic-kanban/shared/lib/error-message";
import { PluginError } from "./plugin-errors.js";

/**
 * Per-project enable/disable of an installed plugin: skill fan-out (junction, copy
 * fallback), scaffold fan-out, and the pref that gates everything else. Extracted
 * from plugin.service.ts as its own cohesive module (god-module ceiling) — the
 * plugin service facade re-exposes these behind unchanged method names.
 */
export interface EnableReport {
  prefKey: string;
  skills: Array<{ name: string; mode: "junction" | "copy" | "skipped-existing" | "missing-source" }>;
  scaffoldWritten: boolean;
  /** Unfilled `TODO:` markers in the just-written scaffold file (0 when nothing was written). */
  scaffoldPlaceholders: number;
  warnings: string[];
}

/**
 * Materialize every skill a plugin declares into `<repoPath>/.claude/skills/<name>` — a junction
 * to the plugin checkout, or a copy when the junction cannot be created — and git-exclude it.
 *
 * Module-level and dependency-free ON PURPOSE (#1039): enabling was the ONLY caller, so a
 * project whose pref said `plugin_enabled_<slug>=true` but whose `.claude/skills/<name>` had
 * gone (a dangling junction after the plugin checkout moved, a hand-deleted directory, a pref
 * flipped without the enable path) stayed broken forever — `copySkillToWorktree` returned
 * false into every new worktree and nothing said so. The provisioning seam now calls this to
 * heal that state before it copies, which needs the fan-out reachable without the ops factory.
 *
 * Idempotent: an existing, RESOLVING target is `skipped-existing`. A target that is a link whose
 * destination no longer exists is replaced rather than skipped — `isLinkPath` is true for a
 * dangling junction, and skipping it is exactly how the missing-skill state became permanent.
 */
export function fanOutPluginSkills(
  plugin: { localPath: string; manifest: PluginManifest },
  repoPath: string,
  report: EnableReport,
): void {
  for (const skill of plugin.manifest.skills ?? []) {
    const name = pluginSkillName(skill.dir);
    const source = resolveInside(plugin.localPath, skill.dir, `skill dir "${skill.dir}"`);
    if (!existsSync(source)) {
      report.skills.push({ name, mode: "missing-source" });
      report.warnings.push(`skill dir not found in plugin: ${skill.dir}`);
      continue;
    }
    const skillsRoot = skillsDirOf(repoPath);
    const target = skillDirOf(repoPath, name);
    if (isLinkPath(target) && !existsSync(target)) {
      // A junction whose destination is gone. `existsSync` follows the link, so this is the
      // one shape that is "present" to the skip check and absent to every reader.
      try {
        removeLink(target);
        report.warnings.push(`replaced dangling skill link "${name}" (its target no longer existed)`);
      } catch (err) {
        report.warnings.push(`dangling skill link "${name}" could not be removed: ${errorMessage(err)}`);
      }
    }
    if (existsSync(target)) {
      report.skills.push({ name, mode: "skipped-existing" });
    } else {
      mkdirSync(skillsRoot, { recursive: true });
      try {
        symlinkSync(source, target, "junction");
        report.skills.push({ name, mode: "junction" });
      } catch (err) {
        try {
          cpSync(source, target, { recursive: true });
          report.skills.push({ name, mode: "copy" });
        } catch (copyErr) {
          report.warnings.push(
            `failed to link or copy skill "${name}": ${errorMessage(copyErr)} (junction error: ${errorMessage(err)})`,
          );
          continue;
        }
      }
    }
    addToGitInfoExclude(repoPath, `.claude/skills/${name}`);
    addToGitInfoExclude(repoPath, `.claude/skills/${name}/`);
  }
}

/**
 * The `skillOverrides` entries this plugin's skills resolve to for this project (#1251) — one
 * per manifest-declared skill, via the same precedence `materializeWorkspaceSkills`'s Pi filter
 * uses (project override -> manifest hint -> global default). Computed at enable/disable time
 * so `.claude/settings.local.json` starts correct without waiting for a launch to read it.
 */
export async function resolveSkillOverridesFor(
  plugin: PluginRow & { manifest: PluginManifest },
  projectId: string,
  database: Database,
): Promise<Record<string, SkillListing>> {
  const prefSource = toPrefMap(await getAllPreferences(database));
  const overrides: Record<string, SkillListing> = {};
  for (const skill of plugin.manifest.skills ?? []) {
    const name = pluginSkillName(skill.dir);
    const projectOverrides = parsePluginSkillListingOverrides(
      prefSource.get(pluginSkillListingPreferenceKey(plugin.pluginId, projectId)),
    ).overrides;
    overrides[name] = resolvePluginSkillListing({
      skillName: name,
      projectOverrides,
      manifestListing: skill.listing,
      globalDefault: prefSource.get("plugin_skill_listing_default"),
    });
  }
  return overrides;
}

/**
 * An operator's explicit per-skill listing override (#1252) — merged into the project's
 * `plugin_skill_listing_<slug>_<projectId>` JSON map, then re-run through
 * `applySkillListingOverrides` for the MAIN checkout (the Plugins view's own scope; a
 * worktree gets its resolution fresh at provisioning time via `resolveSkillOverridesFor`).
 */
async function setSkillListingMode(
  plugin: PluginRow & { manifest: PluginManifest },
  project: { id: string; repoPath: string },
  skillName: string,
  mode: string,
  database: Database,
): Promise<{ overrides: Record<string, SkillListing>; warning: string | null }> {
  if (!isSkillListing(mode)) {
    throw new PluginError(
      `mode must be one of: on, name-only, user-invocable-only, off (got ${JSON.stringify(mode)})`,
      "BAD_REQUEST",
    );
  }
  const declaredNames = (plugin.manifest.skills ?? []).map((s) => pluginSkillName(s.dir));
  if (!declaredNames.includes(skillName)) {
    throw new PluginError(`Skill "${skillName}" is not declared by this plugin`, "NOT_FOUND");
  }

  const prefKey = pluginSkillListingPreferenceKey(plugin.pluginId, project.id);
  const prefSource = toPrefMap(await getAllPreferences(database));
  const existingOverrides = getJson<Record<string, string>>(prefSource, prefKey, {});
  const mergedOverrides = { ...existingOverrides, [skillName]: mode };
  await setPreferenceChecked(database, [{ key: prefKey, value: JSON.stringify(mergedOverrides) }]);

  // Re-resolve every declared skill (not just the one just set) so the settings.local.json
  // write reflects the full, current precedence chain for this project.
  const overrides = await resolveSkillOverridesFor(plugin, project.id, database);
  const result = await applySkillListingOverrides(project.repoPath, overrides);
  return { overrides, warning: result.warning };
}

export function createPluginEnablementOps(deps: {
  database: Database;
  requirePlugin: (id: string) => Promise<PluginRow & { manifest: PluginManifest }>;
  requireProject: (projectId: string) => Promise<{ id: string; repoPath: string; name: string }>;
  resolveOutputRepoPath: (
    plugin: PluginRow & { manifest: PluginManifest },
    project: { id: string; repoPath: string },
  ) => Promise<string>;
  setOutputLocation: (pluginRowId: string, projectId: string, location: string) => Promise<unknown>;
}) {
  const { database, requirePlugin, requireProject, resolveOutputRepoPath, setOutputLocation } = deps;

  /** #1251: write the enabled plugins' skill listings (skillOverrides) next to the fanned-out skills. */
  async function applySkillListings(projectId: string, repoPath: string, warnings: string[]) {
    const result = await syncPluginSkillOverrides(database, projectId, repoPath);
    warnings.push(...result.warnings);
    if (result.status === "skipped-tracked" || result.status === "failed") {
      const message = `skill listings not applied: ${result.message ?? result.status}`;
      warnings.push(message);
      console.warn(`[plugins] ${message}`);
    }
  }

  function fanOutSkills(plugin: PluginRow & { manifest: PluginManifest }, repoPath: string, report: EnableReport) {
    fanOutPluginSkills(plugin, repoPath, report);
  }

  /** #318: optional `location` FIRST — enabling scaffolds, so choosing it afterwards left the
   *  scaffold in the leading repo. Delegates for validation + eager sidecar creation. */
  async function enableForProject(pluginRowId: string, projectId: string, location?: string): Promise<EnableReport> {
    if (location !== undefined) await setOutputLocation(pluginRowId, projectId, location);
    const plugin = await requirePlugin(pluginRowId);
    const project = await requireProject(projectId);
    const prefKey = pluginEnabledPreferenceKey(plugin.pluginId, projectId);
    await setPreferenceChecked(database, [{ key: prefKey, value: "true" }]);

    const report: EnableReport = { prefKey, skills: [], scaffoldWritten: false, scaffoldPlaceholders: 0, warnings: [] };
    fanOutSkills(plugin, project.repoPath, report);
    await applySkillListings(projectId, project.repoPath, report.warnings);
    const outputRepoPath = await resolveOutputRepoPath(plugin, project);
    await fanOutScaffold(plugin, outputRepoPath, project.repoPath, project.name, report);

    if ((plugin.manifest.skills ?? []).length > 0) {
      const overrides = await resolveSkillOverridesFor(plugin, projectId, database);
      const result = await applySkillListingOverrides(project.repoPath, overrides);
      if (result.warning) report.warnings.push(result.warning);
    }
    return report;
  }

  async function disableForProject(pluginRowId: string, projectId: string): Promise<{ prefKey: string; skillsRemoved: string[] }> {
    const plugin = await requirePlugin(pluginRowId);
    const project = await requireProject(projectId);
    const prefKey = pluginEnabledPreferenceKey(plugin.pluginId, projectId);
    await setPreferenceChecked(database, [{ key: prefKey, value: "false" }]);

    // Stop this plugin's serve processes for the project.
    stopPluginViews(pluginRowId, projectId);
    await deletePluginViewProcessesForPlugin(pluginRowId, projectId, database);

    // Remove skill JUNCTIONS only — a path that is a real directory (copy fallback
    // or a pre-existing project skill) is NEVER deleted.
    const skillsRemoved: string[] = [];
    for (const skill of plugin.manifest.skills ?? []) {
      const name = pluginSkillName(skill.dir);
      const target = skillDirOf(project.repoPath, name);
      if (!isLinkPath(target)) continue;
      removeLink(target);
      skillsRemoved.push(name);
    }
    await applySkillListings(projectId, project.repoPath, []);

    const allSkillNames = (plugin.manifest.skills ?? []).map((s) => pluginSkillName(s.dir));
    if (allSkillNames.length > 0) {
      await removeSkillListingOverrides(project.repoPath, allSkillNames);
    }
    return { prefKey, skillsRemoved };
  }

  /** Set one skill's project-scoped listing override and re-sync the main checkout (#1252). */
  async function setSkillListingModeForProject(pluginRowId: string, projectId: string, skillName: string, mode: string) {
    const plugin = await requirePlugin(pluginRowId);
    const project = await requireProject(projectId);
    return setSkillListingMode(plugin, project, skillName, mode, database);
  }

  return { fanOutSkills, enableForProject, disableForProject, setSkillListingModeForProject };
}
