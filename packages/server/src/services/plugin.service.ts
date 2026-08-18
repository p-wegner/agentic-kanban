import { existsSync, readFileSync } from "node:fs";
import { listWorkflowTemplates, type WorkflowDb } from "@agentic-kanban/shared/lib/workflow-engine";
import {
  parsePluginManifest,
  pluginSkillName,
  substitutePluginEnv,
  substitutePluginPlaceholders,
  type PluginManifest,
  type PluginPlaceholderVars,
} from "@agentic-kanban/shared/lib/plugin-manifest";
import { isPluginEnabledPreferenceKey } from "@agentic-kanban/shared/lib/dynamic-preference-keys";
import { parseBoolSetting } from "@agentic-kanban/shared/lib/settings-registry";
import type { Database } from "../db/index.js";
import { resolvePublicBoardUrl } from "../runtime-port.js";
import { runPluginCommand, type PluginCommandResult } from "./plugin-exec.js";
import { createPluginLoopEngine, type LoopAdvanceResult, type LoopStatus } from "./plugin-loop.service.js";
import { getProjectById } from "../repositories/project.repository.js";
import { createPluginOutputLocationOps } from "./plugin-output-location.service.js";
import {
  getPluginRowById,
  listPluginEnabledPreferences,
  listPluginRows,
  type PluginRow,
} from "../repositories/plugins.repository.js";
import type { CreateIssueInput, CreateIssueResult } from "./issue.service.js";
import type { CreateWorkspaceInput, CreateWorkspaceResult } from "./workspace-internals.js";
import { createPluginEnablementOps } from "./plugin-enablement.service.js";
import { createPluginLifecycleOps } from "./plugin-lifecycle.service.js";
import { createPluginListingOps } from "./plugin-listing.service.js";
import { createPluginProjectSurfaceOps } from "./plugin-project-surface.service.js";

/**
 * Plugin system core (server side).
 *
 * A plugin = a repo with a `kanban-plugin.json` manifest. Install registers it in
 * the `plugins` table (cloning git sources into ~/.agentic-kanban/plugins via the
 * ONE sanctioned git adapter); enabling it for a project sets the
 * `plugin_enabled_<slug>_<projectId>` pref through the checked preference write and
 * fans out skills (junction, copy fallback), the scaffold template, and butler
 * prompt fragments. Views are child HTTP servers supervised here (spawned
 * windowsHide via the shared shell spec, port from listen(0), killed on shutdown).
 *
 * Plugin SCRIPTS run through the plugin routes (`runScript`), NOT through the
 * project-scripts shortcut table: shortcuts carry no env column and constrain
 * workingDir to inside the project root, while plugin scripts need substituted env
 * and often run in the plugin's own checkout (cwd: "plugin") — outside the repo.
 * Documented decision; revisit only if shortcuts grow an env/cwd-out-of-repo model.
 */

// Re-exported so existing `import { PluginError } from "./plugin.service.js"` keeps working.
export { PluginError } from "./plugin-errors.js";
import { resolveInside } from "./plugin-fs.js";
import { PluginError } from "./plugin-errors.js";
import { requireScaffoldReady } from "./plugin-scaffold.js";
import { createPluginLoopExtras, validatePluginSource } from "./plugin-loop-extras.service.js";
import type { BoardEvents } from "./board-events.js";
import {
  createPluginViewsRuntime,
  stopAllPluginViews,
  stopAllPluginViewsAsync,
  type PluginViewProcess,
} from "./plugin-views.service.js";
import { pluginsHomeDir } from "./plugin-fs.js";
import { marketplaceCatalogPath, type PluginMarketplaceEntry } from "./plugin-marketplace.js";
import {
  upsertPluginViewProcess,
  deletePluginViewProcess,
} from "../repositories/plugin-view-processes.repository.js";

// Re-exported so existing importers keep working after the split. `stopAllPluginViews` is the
// shutdown handler's entry point (`startup/process-handlers.ts`) and several tests import it from
// here; the view child-process map now lives in ONE place, `plugin-views.service.ts`.
export { pluginsHomeDir, marketplaceCatalogPath, stopAllPluginViews, stopAllPluginViewsAsync };
export type { PluginMarketplaceEntry, PluginViewProcess };

export type PluginScriptResult = PluginCommandResult;

// `EnableReport`/`PluginUpdateResult` now live in the modules that own the behavior
// behind them (plugin-enablement.service.ts / plugin-lifecycle.service.ts) — re-exported
// here so `import { EnableReport } from "./plugin.service.js"` keeps working.
export type { EnableReport } from "./plugin-enablement.service.js";
export type { PluginUpdateResult } from "./plugin-lifecycle.service.js";

export interface PluginSkillRunResult {
  issueId: string;
  issueNumber: number | null;
  workspaceId: string;
  branch: string;
}

/**
 * Stages of a skill launch, in order. The ticket lands in milliseconds and the workspace behind
 * it takes minutes (worktree → the project's setup script → agent launch), so a launcher that
 * only sees the final result stares at a spinner with no evidence anything happened — while the
 * ticket has in fact been on the board the whole time.
 */
export type PluginSkillRunProgress =
  | { stage: "ticket"; issueId: string; issueNumber: number | null; title: string }
  | { stage: "workspace"; issueId: string; issueNumber: number | null; setupScript: string | null }
  | ({ stage: "done" } & PluginSkillRunResult);

export function createPluginService(deps: {
  database: Database;
  /** Injected rather than self-HTTP'd (see server/CLAUDE.md "Self-HTTP calls are an anti-pattern"). */
  createIssue?: (input: CreateIssueInput) => Promise<CreateIssueResult>;
  createWorkspace?: (input: CreateWorkspaceInput) => Promise<CreateWorkspaceResult>;
  /** Externally reachable board API base URL for `{{boardUrl}}` (#236). Defaults to the
   *  public (proxy-fronted) URL derived from the runtime env — a worktree server on 3001+N
   *  produces its own URL. Injectable so tests need no env fiddling. */
  boardUrl?: string;
  /** For the gate-reached WS notification (#287). */
  boardEvents?: BoardEvents;
}) {
  const { database, createIssue, createWorkspace, boardEvents } = deps;
  const boardUrl = deps.boardUrl ?? resolvePublicBoardUrl();
  const loops = createPluginLoopEngine({ database, createIssue, createWorkspace, boardUrl, boardEvents });
  // Output-location concern extracted to its own module (god-module ceiling);
  // same function names, unchanged behavior — see plugin-output-location.service.ts.
  // Placed before the views runtime below, which captures resolveOutputRepoPath at init.
  // (requirePlugin/requireProject are hoisted function declarations, so referencing
  // them here is safe.)
  const {
    readOutputLocationPref,
    resolveOutputRepoPath,
    peekOutputRepoPath,
    getOutputLocation,
    setOutputLocation,
  } = createPluginOutputLocationOps({ database, requirePlugin, requireProject });
  /**
   * The view child-server lifecycle lives in `plugin-views.service.ts` — it owns the module-level
   * process map, so this is the only place it gets bound to a service closure. Do NOT reach for the
   * map from here; use these functions and `stopPluginViews()`.
   */
  const { startView, stopView, getViewStatus, listViews, listProjectViews } = createPluginViewsRuntime({
    requirePlugin,
    requireProject,
    resolveOutputRepoPath,
    enabledSlugsByProject,
    listPluginRows: () => listPluginRows(database),
    parseManifest: parsePluginManifest,
    boardUrl,
    // PID bookkeeping for the startup reap of orphaned view servers (#228).
    persistViewProcess: (values) => upsertPluginViewProcess(values, database),
    dropViewProcess: (pluginRowId, viewId, projectId) => deletePluginViewProcess(pluginRowId, viewId, projectId, database),
  });

  async function requirePlugin(id: string): Promise<PluginRow & { manifest: PluginManifest }> {
    const row = await getPluginRowById(id, database);
    if (!row) throw new PluginError("Plugin not found", "NOT_FOUND");
    return { ...row, manifest: parsePluginManifest(row.manifestJson) };
  }

  async function requireProject(projectId: string) {
    const project = await getProjectById(projectId, database);
    if (!project) throw new PluginError("Project not found", "NOT_FOUND");
    return project;
  }

  async function enabledSlugsByProject(): Promise<Map<string, Set<string>>> {
    const rows = await listPluginEnabledPreferences(database);
    const map = new Map<string, Set<string>>();
    for (const row of rows) {
      // plugin_enabled_* has no SETTINGS_REGISTRY entry (dynamic per-plugin-per-project key),
      // so parseBoolSetting falls back to the explicit `false` default below — same polarity
      // as the raw `!== "true"` check this replaces, but routed through the #947 accessor.
      if (!isPluginEnabledPreferenceKey(row.key) || !parseBoolSetting(row.key, row.value, false)) continue;
      // key = plugin_enabled_<slug>_<uuid>; the uuid is the fixed-length tail.
      const rest = row.key.slice("plugin_enabled_".length);
      const projectId = rest.slice(-36);
      const slug = rest.slice(0, -37);
      if (!map.has(projectId)) map.set(projectId, new Set());
      map.get(projectId)!.add(slug);
    }
    return map;
  }

  // Per-project enable/disable + skill fan-out extracted to its own module
  // (god-module ceiling) — see plugin-enablement.service.ts.
  const { fanOutSkills, enableForProject, disableForProject } = createPluginEnablementOps({
    database, requirePlugin, requireProject, resolveOutputRepoPath, setOutputLocation,
  });

  // Install/update/remove of a plugin ROW extracted to its own module (god-module
  // ceiling) — see plugin-lifecycle.service.ts. Depends on `fanOutSkills` above so a
  // manifest update can re-materialize a newly declared skill (#443).
  const { installPlugin, updatePlugin, removePlugin } = createPluginLifecycleOps({
    database, requireProject, enabledSlugsByProject, fanOutSkills,
  });

  // Read-side listing (short-TTL memo, marketplace merge, manifest-drift verdict)
  // extracted to its own module (god-module ceiling) — see plugin-listing.service.ts.
  const { listPlugins, listMarketplace, readManifestDrift, invalidatesPluginList } = createPluginListingOps({
    database, enabledSlugsByProject, readOutputLocationPref,
  });

  /**
   * What an enabled plugin can be ASKED to do, derived from its manifest so it cannot drift out of
   * date the way hand-written prose does. Returns "" when the plugin declares neither skills nor
   * loops, so a plugin with nothing to offer adds nothing to the butler's context.
   */
  function pluginCapabilityRoster(manifest: PluginManifest): string {
    const lines: string[] = [];
    const skills = manifest.skills ?? [];
    if (skills.length) {
      lines.push("**Skills it provides** (run one to create a ticket and launch a workspace against it):");
      for (const s of skills) {
        const name = pluginSkillName(s.dir);
        lines.push(s.description ? `- \`${name}\` — ${s.description}` : `- \`${name}\``);
      }
    }
    const loops = manifest.loops ?? [];
    if (loops.length) {
      if (lines.length) lines.push("");
      lines.push("**Converging loops** (each advance tickets the units its plan says are ready):");
      for (const l of loops) {
        const via = l.skill ? ` — hands out \`${l.skill}\`` : "";
        lines.push(`- \`${l.name}\`${l.label && l.label !== l.name ? ` (${l.label})` : ""}${via}`);
      }
    }
    return lines.join("\n");
  }

  async function getButlerFragments(projectId: string): Promise<string[]> {
    const enabled = (await enabledSlugsByProject()).get(projectId);
    if (!enabled || enabled.size === 0) return [];
    let project: { id: string; repoPath: string; name: string } | null = null;
    try {
      project = await requireProject(projectId);
    } catch {
      return [];
    }
    const fragments: string[] = [];
    for (const row of await listPluginRows(database)) {
      if (!enabled.has(row.pluginId)) continue;
      try {
        const manifest = parsePluginManifest(row.manifestJson);
        // `{{repoPath}}` is the OUTPUT repo at every other substitution site; this one used to
        // hand the butler the LEADING repo for both placeholders, so in sidecar mode a fragment
        // saying "the register lives in {{repoPath}}/docs" named a path with nothing in it.
        // Resolved WITHOUT creating anything — assembling a prompt must not materialize a repo —
        // so a sidecar that has not been created yet still falls back to the leading repo.
        const vars = {
          repoPath: await peekOutputRepoPath(row.pluginId, project),
          leadingRepoPath: project.repoPath,
          projectName: project.name,
          pluginPath: row.localPath,
          boardUrl,
          projectId,
        };

        const parts: string[] = [];
        if (manifest.butler?.promptFragment) {
          const fragmentPath = resolveInside(row.localPath, manifest.butler.promptFragment, "butler.promptFragment");
          if (existsSync(fragmentPath)) {
            const text = substitutePluginPlaceholders(readFileSync(fragmentPath, "utf8"), vars).trim();
            if (text) parts.push(text);
          }
        }

        // The roster is DERIVED, not authored. A plugin's own fragment is written by its author and
        // drifts: it explains how to consume the output and rarely lists what the plugin can be
        // ASKED to do. So every enabled plugin contributes its skills and loops here automatically,
        // and a plugin that ships no fragment at all still announces its capabilities instead of
        // being invisible. Skill names are the directory basenames — the same identifiers
        // `loops[].skill` uses and the same ones materialized into each ticket's worktree.
        const roster = pluginCapabilityRoster(manifest);
        if (roster) parts.push(roster);

        if (parts.length) fragments.push(`## Plugin: ${row.name}\n\n${parts.join("\n\n")}`);
      } catch {
        /* a broken plugin must never take the butler down */
      }
    }
    return fragments;
  }

  async function runScript(pluginRowId: string, scriptName: string, projectId: string): Promise<PluginScriptResult> {
    const plugin = await requirePlugin(pluginRowId);
    const project = await requireProject(projectId);
    const script = (plugin.manifest.scripts ?? []).find((s) => s.name === scriptName);
    if (!script) throw new PluginError(`Script "${scriptName}" not found in plugin manifest`, "NOT_FOUND");
    const outputRepoPath = await resolveOutputRepoPath(plugin, project);
    await requireScaffoldReady(plugin, outputRepoPath, "scripts");

    const vars: PluginPlaceholderVars = {
      repoPath: outputRepoPath,
      leadingRepoPath: project.repoPath,
      projectName: project.name,
      pluginPath: plugin.localPath,
      boardUrl,
      projectId,
    };
    return runPluginCommand(substitutePluginPlaceholders(script.command, vars), {
      cwd: script.cwd === "plugin" ? plugin.localPath : outputRepoPath,
      env: substitutePluginEnv(script.env, vars),
    });
  }

  /**
   * Launch an agentic (judgment-requiring) plugin skill against a project — the
   * counterpart to `runScript` for the manifest's `skills` entries, which cannot be
   * a deterministic subprocess (e.g. `prd-consolidation` reads/translates analysis
   * docs, it doesn't just shell out). Creates a ticket carrying the skill's brief,
   * then launches a workspace against it exactly like the board's own "New
   * Workspace" flow — so it inherits the project's Strategy Bullseye provider
   * selection, review, and merge gates, same as any other ticket.
   */
  async function runSkill(
    pluginRowId: string,
    skillName: string,
    projectId: string,
    opts?: {
      title?: string;
      description?: string;
      prompt?: string;
      /** Explicit workflow template for the ticket; overrides the manifest's declared default. */
      workflowTemplateId?: string | null;
      onProgress?: (event: PluginSkillRunProgress) => void;
    },
  ): Promise<PluginSkillRunResult> {
    if (!createIssue || !createWorkspace) {
      throw new PluginError("Skill execution is not available on this route", "BAD_REQUEST");
    }
    const plugin = await requirePlugin(pluginRowId);
    const project = await requireProject(projectId);
    const skillDef = (plugin.manifest.skills ?? []).find((s) => pluginSkillName(s.dir) === skillName);
    if (!skillDef) throw new PluginError(`Skill "${skillName}" not found in plugin manifest`, "NOT_FOUND");

    // Workflow precedence: what the launcher picked → what the plugin declares for this skill →
    // the board's per-issue-type default. The launcher's choice always wins; the manifest only
    // supplies a better starting point than "whatever the board does for a generic task".
    const workflowTemplateId = opts?.workflowTemplateId
      ?? await resolveWorkflowTemplateId(projectId, skillDef.workflow);

    const title = opts?.title?.trim() || `${plugin.name}: run ${skillName}`;
    const base = opts?.description?.trim()
      || `Run the \`${skillName}\` skill from the "${plugin.name}" plugin against this project.`;
    // `prompt` is what the launcher typed: extra context for THIS run ("only the billing
    // module", "focus on the error paths"). It is APPENDED rather than substituted, because a
    // description that replaced the base would drop the one sentence naming the skill to run.
    const extra = opts?.prompt?.trim();
    const description = extra ? `${base}\n\n## Additional context for this run\n\n${extra}` : base;

    const issue = await createIssue({
      projectId,
      title,
      description,
      issueType: "task",
      priority: "medium",
      skipAutoReview: true,
      workflowTemplateId,
    });
    // The ticket exists within milliseconds; provisioning the workspace behind it takes MINUTES
    // (worktree, then the project's setup script, then the agent launch). Reporting the ticket
    // now is the difference between "nothing happened" and "it is running" — see the route's
    // streaming mode, which forwards these to the launcher.
    opts?.onProgress?.({ stage: "ticket", issueId: issue.id, issueNumber: issue.issueNumber, title });
    opts?.onProgress?.({
      stage: "workspace",
      issueId: issue.id,
      issueNumber: issue.issueNumber,
      setupScript: project.setupEnabled === false ? null : project.setupScript ?? null,
    });

    const workspace = await createWorkspace({ issueId: issue.id, skillName });
    const result = {
      issueId: issue.id,
      issueNumber: issue.issueNumber,
      workspaceId: workspace.id,
      branch: workspace.branch,
    };
    opts?.onProgress?.({ stage: "done", ...result });
    return result;
  }

  /**
   * Resolve a manifest's `workflow` string to a template id for this project.
   *
   * Accepts a builtin key (`research-task`), a template name ("Research Task"), or an id, in
   * that order — a plugin ships one manifest for every board, so it cannot know local template
   * ids, and builtin keys are the only stable handle across installs. An unresolvable value is
   * NOT an error: the board's own default takes over and a warning is logged, because a plugin
   * naming a workflow this board has never heard of should degrade, not block the launch.
   */
  async function resolveWorkflowTemplateId(
    projectId: string,
    workflow: string | undefined,
  ): Promise<string | null> {
    const wanted = workflow?.trim();
    if (!wanted) return null;
    const templates = await listWorkflowTemplates(database as unknown as WorkflowDb, projectId);
    const needle = wanted.toLowerCase();
    const match = templates.find((t) => t.builtinKey?.toLowerCase() === needle)
      ?? templates.find((t) => t.name.toLowerCase() === needle)
      ?? templates.find((t) => t.id === wanted);
    if (!match) {
      console.warn(`[plugins] workflow "${wanted}" not found for project ${projectId} — using the board default`);
      return null;
    }
    return match.id;
  }

  /** Per-loop ticket counts for one plugin (cheap — does not run the planner). */
  async function listLoops(pluginRowId: string, projectId: string): Promise<LoopStatus[]> {
    const plugin = await requirePlugin(pluginRowId);
    await requireProject(projectId);
    return loops.loopStatuses(plugin.manifest, plugin.pluginId, projectId);
  }

  /**
   * Advance one converging loop: plan, then create a ticket per outstanding unit.
   * The board's monitor is what STARTS those tickets — see plugin-loop.service.
   */
  async function advanceLoop(pluginRowId: string, loopName: string, projectId: string): Promise<LoopAdvanceResult> {
    const plugin = await requirePlugin(pluginRowId);
    const project = await requireProject(projectId);
    const outputRepoPath = await resolveOutputRepoPath(plugin, project);
    await requireScaffoldReady(plugin, outputRepoPath, "loops");
    // A loop declares its own workflow, or inherits the one its skill declares — nobody is at
    // the keyboard when the monitor advances a round, so the manifest is the only place this
    // choice can come from.
    const loopDef = (plugin.manifest.loops ?? []).find((l) => l.name === loopName);
    const skillDef = (plugin.manifest.skills ?? []).find((s) => pluginSkillName(s.dir) === loopDef?.skill);
    const workflowTemplateId = await resolveWorkflowTemplateId(
      projectId,
      loopDef?.workflow ?? skillDef?.workflow,
    );
    return loops.advanceLoop({
      pluginRowId: plugin.id,
      manifest: plugin.manifest,
      pluginSlug: plugin.pluginId,
      pluginName: plugin.name,
      pluginLocalPath: plugin.localPath,
      loopName,
      projectId,
      projectName: project.name,
      repoPath: outputRepoPath,
      leadingRepoPath: project.repoPath,
      workflowTemplateId,
    });
  }

  // Loop-adjacent extras (#286–#295) — gate resolve, timeline+costs, artifacts,
  // scaffold form. Extracted to plugin-loop-extras.service.ts (god-module ceiling);
  // composed with this service's own closures, like the views runtime above.
  const {
    resolveLoopGate, listLoopEvents, getLoopArtifact, getScaffoldForm, saveScaffoldContent,
    fillScaffoldForm, saveLoopArtifact, draftLoopGateFeedback, summarizeLoopGate,
  } = createPluginLoopExtras({
    database,
    loops,
    requirePlugin,
    requireProject,
    resolveOutputRepoPath,
    resolveWorkflowTemplateId,
  });


  /** Pause/resume a loop's monitor-driven auto-advance. Manual "Advance now" still works. */
  async function setLoopPaused(pluginRowId: string, loopName: string, projectId: string, paused: boolean): Promise<LoopStatus[]> {
    const plugin = await requirePlugin(pluginRowId);
    await requireProject(projectId);
    await loops.setLoopPaused(plugin.manifest, plugin.pluginId, loopName, projectId, paused);
    return loops.loopStatuses(plugin.manifest, plugin.pluginId, projectId);
  }

  // "Everything the enabled plugins offer this project (or projects)" reads extracted
  // to their own module (god-module ceiling) — see plugin-project-surface.service.ts.
  const { listProjectSurface, listProjectLoops, listLoopSurfacesForProjects } = createPluginProjectSurfaceOps({
    database, requireProject, enabledSlugsByProject, loops, readManifestDrift, getViewStatus,
  });

  return {
    // Listing-affecting mutators clear the listPlugins memo (#418).
    installPlugin: invalidatesPluginList(installPlugin),
    updatePlugin: invalidatesPluginList(updatePlugin),
    listPlugins,
    listMarketplace,
    listLoops,
    listProjectLoops,
    listProjectSurface,
    listLoopSurfacesForProjects,
    advanceLoop,
    setLoopPaused,
    resolveLoopGate,
    listLoopEvents,
    getLoopArtifact,
    getScaffoldForm,
    saveScaffoldContent,
    fillScaffoldForm,
    saveLoopArtifact,
    draftLoopGateFeedback,
    summarizeLoopGate,
    validatePluginSource,
    removePlugin: invalidatesPluginList(removePlugin),
    enableForProject: invalidatesPluginList(enableForProject),
    disableForProject: invalidatesPluginList(disableForProject),
    getButlerFragments,
    listViews,
    listProjectViews,
    startView,
    stopView,
    getViewStatus,
    runScript,
    runSkill,
    getOutputLocation,
    setOutputLocation: invalidatesPluginList(setOutputLocation),
  };
}

export type PluginService = ReturnType<typeof createPluginService>;

const singletons = new Map<Database, PluginService>();
const singletonDeps = new Map<Database, PluginServiceSkillDeps>();

export interface PluginServiceSkillDeps {
  createIssue?: (input: CreateIssueInput) => Promise<CreateIssueResult>;
  createWorkspace?: (input: CreateWorkspaceInput) => Promise<CreateWorkspaceResult>;
  boardEvents?: BoardEvents;
}

/**
 * Memoized per-database singleton, like sibling services' lazy accessors.
 *
 * `skillDeps` (createIssue/createWorkspace) are ACCUMULATED rather than bound to
 * whichever caller happened to construct the instance first. Several composition
 * points reach for this service — the plugins route (which has the deps), the
 * plugin-views route and the monitor's loop pass (which don't) — and binding on
 * first call meant that if a dep-less caller won the race, `runSkill` and
 * `advanceLoop` were permanently dead with "not available on this route" for the
 * whole process lifetime, depending only on module import order. So a later call
 * that supplies a missing dep rebuilds the instance with the union.
 */
export function getPluginService(database: Database, skillDeps?: PluginServiceSkillDeps): PluginService {
  const known = singletonDeps.get(database) ?? {};
  const merged: PluginServiceSkillDeps = {
    createIssue: known.createIssue ?? skillDeps?.createIssue,
    createWorkspace: known.createWorkspace ?? skillDeps?.createWorkspace,
    boardEvents: known.boardEvents ?? skillDeps?.boardEvents,
  };
  const gainedDeps = merged.createIssue !== known.createIssue
    || merged.createWorkspace !== known.createWorkspace
    || merged.boardEvents !== known.boardEvents;

  let service = singletons.get(database);
  if (!service || gainedDeps) {
    service = createPluginService({ database, ...merged });
    singletons.set(database, service);
    singletonDeps.set(database, merged);
  }
  return service;
}
