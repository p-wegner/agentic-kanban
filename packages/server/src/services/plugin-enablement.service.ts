import { existsSync, mkdirSync, symlinkSync, cpSync } from "node:fs";
import { join } from "node:path";
import { skillDirOf, skillsDirOf } from "@agentic-kanban/shared/lib/agent-skill-files";
import { setPreferenceChecked } from "@agentic-kanban/shared/lib/checked-preference-write";
import {
  pluginEnabledPreferenceKey,
  pluginSkillName,
  type PluginManifest,
} from "@agentic-kanban/shared/lib/plugin-manifest";
import type { Database } from "../db/index.js";
import type { PluginRow } from "../repositories/plugins.repository.js";
import { resolveInside, addToGitInfoExclude, isLinkPath, removeLink } from "./plugin-fs.js";
import { fanOutScaffold } from "./plugin-scaffold.js";
import { stopPluginViews } from "./plugin-views.service.js";
import { deletePluginViewProcessesForPlugin } from "../repositories/plugin-view-processes.repository.js";
import { errorMessage } from "@agentic-kanban/shared/lib/error-message";

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
    const outputRepoPath = await resolveOutputRepoPath(plugin, project);
    await fanOutScaffold(plugin, outputRepoPath, project.repoPath, project.name, report);
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
    return { prefKey, skillsRemoved };
  }

  return { fanOutSkills, enableForProject, disableForProject };
}
