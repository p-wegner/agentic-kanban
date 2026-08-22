import {
  parsePluginManifest,
  substitutePluginEnv,
  substitutePluginPlaceholders,
  type PluginManifest,
} from "@agentic-kanban/shared/lib/plugin-manifest";
import type { Database } from "../db/index.js";
import { resolvePublicBoardUrl } from "../runtime-port.js";
import { runPluginCommand, type PluginCommandResult } from "./plugin-exec.js";
import { createPluginLoopEngine, type LoopAdvanceResult, type LoopStatus } from "./plugin-loop.service.js";
import { getProjectById } from "../repositories/project.repository.js";
import { createPluginOutputLocationOps } from "./plugin-output-location.service.js";
import {
  getPluginRowById,
  listPluginRows,
  type PluginRow,
} from "../repositories/plugins.repository.js";
import type { CreateIssueInput, CreateIssueResult } from "./issue.service.js";
import type { CreateWorkspaceInput, CreateWorkspaceResult } from "./workspace-internals.js";
import { enabledPluginSlugsByProject, listEnabledPlugins } from "./plugin-enabled.js";
import type { PluginLoopRunContext, PluginRunContext } from "./plugin-loop-types.js";
import { createPluginEnablementOps } from "./plugin-enablement.service.js";
import { createPluginLifecycleOps } from "./plugin-lifecycle.service.js";
import { createPluginListingOps } from "./plugin-listing.service.js";
import { createPluginProjectSurfaceOps } from "./plugin-project-surface.service.js";
import { buildButlerFragments } from "./plugin/butler-fragments.js";
import {
  resolveLoopRunContext as resolveLoopRunContextIn,
  resolvePluginRunContext as resolvePluginRunContextIn,
  type RunContextDeps,
} from "./plugin/run-context.js";
import {
  runPluginSkill,
  type PluginSkillRunResult,
  type RunSkillOptions,
} from "./plugin/skill-run.js";
import { resolveWorkflowTemplateId as resolveWorkflowTemplateIdIn } from "./plugin/workflow-resolution.js";

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
import { PluginError } from "./plugin-errors.js";
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

// The agentic skill launch lives in plugin/skill-run.ts; its result/progress types are
// re-exported here because the plugins route and its streaming mode import them from this module.
export type { PluginSkillRunResult, PluginSkillRunProgress } from "./plugin/skill-run.js";

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
    listEnabledPlugins: (projectId) => listEnabledPlugins(projectId, database),
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
    return enabledPluginSlugsByProject(database);
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
   * What the butler is told about the enabled plugins — the author's own fragment plus a DERIVED
   * capability roster. Lives in plugin/butler-fragments.ts; `peekOutputRepoPath` is passed rather
   * than `resolveOutputRepoPath` because assembling a prompt must not materialize a sidecar repo.
   */
  async function getButlerFragments(projectId: string): Promise<string[]> {
    return buildButlerFragments(projectId, { database, boardUrl, requireProject, peekOutputRepoPath });
  }

  async function runScript(pluginRowId: string, scriptName: string, projectId: string): Promise<PluginScriptResult> {
    const plugin = await requirePlugin(pluginRowId);
    const script = (plugin.manifest.scripts ?? []).find((s) => s.name === scriptName);
    if (!script) throw new PluginError(`Script "${scriptName}" not found in plugin manifest`, "NOT_FOUND");
    const { outputRepoPath, vars } = await resolvePluginRunContext(pluginRowId, projectId, { requireScaffoldFor: "scripts" });
    return runPluginCommand(substitutePluginPlaceholders(script.command, vars), {
      cwd: script.cwd === "plugin" ? plugin.localPath : outputRepoPath,
      env: substitutePluginEnv(script.env, vars),
    });
  }

  /**
   * Launch an agentic (judgment-requiring) plugin skill against a project — a ticket carrying the
   * skill's brief plus a workspace against it, so it inherits the board's own provider selection,
   * review and merge gates. See plugin/skill-run.ts.
   */
  async function runSkill(
    pluginRowId: string,
    skillName: string,
    projectId: string,
    opts?: RunSkillOptions,
  ): Promise<PluginSkillRunResult> {
    return runPluginSkill(
      { pluginRowId, skillName, projectId, opts },
      { database, requirePlugin, requireProject, createIssue, createWorkspace },
    );
  }

  /** A manifest's `workflow` string resolved to a template id for this project. */
  async function resolveWorkflowTemplateId(projectId: string, workflow: string | undefined) {
    return resolveWorkflowTemplateIdIn(projectId, workflow, database);
  }

  /** Per-loop ticket counts for one plugin (cheap — does not run the planner). */
  async function listLoops(pluginRowId: string, projectId: string): Promise<LoopStatus[]> {
    const plugin = await requirePlugin(pluginRowId);
    await requireProject(projectId);
    return loops.loopStatuses(plugin.manifest, plugin.pluginId, projectId);
  }

  /**
   * The prelude every plugin entry point shares (#554) — see plugin/run-context.ts, which owns
   * the `{{repoPath}}` = OUTPUT repo / `{{leadingRepoPath}}` = product repo rule (#213).
   */
  const runContextDeps: RunContextDeps = {
    boardUrl, database, requirePlugin, requireProject, resolveOutputRepoPath,
  };

  async function resolvePluginRunContext(
    pluginRowId: string,
    projectId: string,
    opts?: { requireScaffoldFor?: "loops" | "scripts" },
  ): Promise<PluginRunContext> {
    return resolvePluginRunContextIn(pluginRowId, projectId, runContextDeps, opts);
  }

  async function resolveLoopRunContext(
    pluginRowId: string,
    loopName: string,
    projectId: string,
    opts?: { requireScaffoldFor?: "loops" },
  ): Promise<PluginLoopRunContext> {
    return resolveLoopRunContextIn(pluginRowId, loopName, projectId, runContextDeps, opts);
  }

  /**
   * Advance one converging loop: plan, then create a ticket per outstanding unit.
   * The board's monitor is what STARTS those tickets — see plugin-loop.service.
   */
  async function advanceLoop(pluginRowId: string, loopName: string, projectId: string): Promise<LoopAdvanceResult> {
    const { args } = await resolveLoopRunContext(pluginRowId, loopName, projectId, { requireScaffoldFor: "loops" });
    return loops.advanceLoop(args);
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
    resolveLoopRunContext,
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
    database, requireProject, loops, readManifestDrift, getViewStatus,
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
