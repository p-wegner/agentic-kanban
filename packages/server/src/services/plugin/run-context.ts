import {
  buildPluginPlaceholderVars,
  pluginSkillName,
  type PluginManifest,
} from "@agentic-kanban/shared/lib/plugin-manifest";
import type { Database } from "../../db/index.js";
import type { PluginRow } from "../../repositories/plugins.repository.js";
import type { PluginLoopRunContext, PluginRunContext } from "../plugin-loop-types.js";
import { requireScaffoldReady } from "../plugin-scaffold.js";
import { resolveWorkflowTemplateId } from "./workflow-resolution.js";

/**
 * The PRELUDE every plugin entry point runs — resolved once (#554).
 *
 * `requirePlugin → requireProject → resolveOutputRepoPath → optional scaffold check → build the
 * placeholder table` was written out at every entry point (butler fragment, script, view, loop
 * plan, loop gate), and each copy could disagree. One measured copy handed the butler the LEADING
 * repo as `{{repoPath}}`, which in sidecar mode names a directory with nothing in it. The reason
 * it lives in ONE place is that `{{repoPath}}` = OUTPUT repo and `{{leadingRepoPath}}` = product
 * repo (#213) is a rule about all sites at once, and nothing can enforce it per site.
 */

export interface RunContextDeps {
  boardUrl: string;
  database: Database;
  requirePlugin: (id: string) => Promise<PluginRow & { manifest: PluginManifest }>;
  requireProject: (projectId: string) => Promise<{ id: string; name: string; repoPath: string }>;
  resolveOutputRepoPath: (
    plugin: PluginRow & { manifest: PluginManifest },
    project: { id: string; repoPath: string },
  ) => Promise<string>;
}

export async function resolvePluginRunContext(
  pluginRowId: string,
  projectId: string,
  deps: RunContextDeps,
  opts?: { requireScaffoldFor?: "loops" | "scripts" },
): Promise<PluginRunContext> {
  const plugin = await deps.requirePlugin(pluginRowId);
  const project = await deps.requireProject(projectId);
  const outputRepoPath = await deps.resolveOutputRepoPath(plugin, project);
  if (opts?.requireScaffoldFor) await requireScaffoldReady(plugin, outputRepoPath, opts.requireScaffoldFor);
  return {
    plugin,
    project,
    outputRepoPath,
    vars: buildPluginPlaceholderVars({
      outputRepoPath,
      leadingRepoPath: project.repoPath,
      projectName: project.name,
      pluginPath: plugin.localPath,
      boardUrl: deps.boardUrl,
      projectId,
    }),
  };
}

/**
 * The same, plus the flat argument object every loop entry point passes to the loop engine —
 * `advanceLoop` and `resolveLoopGate` built it field by field from identical preludes, including
 * the "a loop declares its own workflow, or inherits its skill's" rule, which nobody is at the
 * keyboard to supply when the monitor advances a round.
 */
export async function resolveLoopRunContext(
  pluginRowId: string,
  loopName: string,
  projectId: string,
  deps: RunContextDeps,
  opts?: { requireScaffoldFor?: "loops" },
): Promise<PluginLoopRunContext> {
  const ctx = await resolvePluginRunContext(pluginRowId, projectId, deps, opts);
  const loopDef = (ctx.plugin.manifest.loops ?? []).find((l) => l.name === loopName);
  const skillDef = (ctx.plugin.manifest.skills ?? []).find((s) => pluginSkillName(s.dir) === loopDef?.skill);
  const workflowTemplateId = await resolveWorkflowTemplateId(
    projectId, loopDef?.workflow ?? skillDef?.workflow, deps.database,
  );
  return {
    ...ctx,
    args: {
      pluginRowId: ctx.plugin.id,
      manifest: ctx.plugin.manifest,
      pluginSlug: ctx.plugin.pluginId,
      pluginName: ctx.plugin.name,
      pluginLocalPath: ctx.plugin.localPath,
      loopName,
      projectId,
      projectName: ctx.project.name,
      repoPath: ctx.outputRepoPath,
      leadingRepoPath: ctx.project.repoPath,
      workflowTemplateId,
    },
  };
}
