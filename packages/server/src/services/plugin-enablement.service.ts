import { existsSync, mkdirSync, symlinkSync, cpSync } from "node:fs";
import { join } from "node:path";
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
    for (const skill of plugin.manifest.skills ?? []) {
      const name = pluginSkillName(skill.dir);
      const source = resolveInside(plugin.localPath, skill.dir, `skill dir "${skill.dir}"`);
      if (!existsSync(source)) {
        report.skills.push({ name, mode: "missing-source" });
        report.warnings.push(`skill dir not found in plugin: ${skill.dir}`);
        continue;
      }
      const skillsRoot = join(repoPath, ".claude", "skills");
      const target = join(skillsRoot, name);
      if (existsSync(target) || isLinkPath(target)) {
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
              `failed to link or copy skill "${name}": ${copyErr instanceof Error ? copyErr.message : String(copyErr)} (junction error: ${err instanceof Error ? err.message : String(err)})`,
            );
            continue;
          }
        }
      }
      addToGitInfoExclude(repoPath, `.claude/skills/${name}`);
      addToGitInfoExclude(repoPath, `.claude/skills/${name}/`);
    }
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
      const target = join(project.repoPath, ".claude", "skills", name);
      if (!isLinkPath(target)) continue;
      removeLink(target);
      skillsRemoved.push(name);
    }
    return { prefKey, skillsRemoved };
  }

  return { fanOutSkills, enableForProject, disableForProject };
}
