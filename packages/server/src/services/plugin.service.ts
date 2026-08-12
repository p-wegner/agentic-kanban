import { createHash, randomUUID } from "node:crypto";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import {
  appendFileSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  rmdirSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { gitExec, gitExecOrThrow } from "@agentic-kanban/shared/lib/git-exec";
import { setPreferenceChecked } from "@agentic-kanban/shared/lib/checked-preference-write";
import { listWorkflowTemplates, type WorkflowDb } from "@agentic-kanban/shared/lib/workflow-engine";
import {
  DEFAULT_PLUGIN_OUTPUT_LOCATION,
  PLUGIN_MANIFEST_FILENAME,
  PLUGIN_OUTPUT_LOCATIONS,
  countScaffoldPlaceholders,
  isPluginOutputLocation,
  parsePluginManifest,
  pluginEnabledPreferenceKey,
  pluginOutputLocationPreferenceKey,
  pluginSidecarRepoName,
  pluginSkillName,
  substitutePluginEnv,
  substitutePluginPlaceholders,
  type PluginManifest,
  type PluginOutputLocation,
  type PluginPlaceholderVars,
} from "@agentic-kanban/shared/lib/plugin-manifest";
import { isPluginEnabledPreferenceKey } from "@agentic-kanban/shared/lib/dynamic-preference-keys";
import { parseBoolSetting } from "@agentic-kanban/shared/lib/settings-registry";
import type { Database } from "../db/index.js";
import { resolvePublicBoardUrl } from "../runtime-port.js";
import { runPluginCommand, type PluginCommandResult } from "./plugin-exec.js";
import { createPluginLoopEngine, type LoopAdvanceResult, type LoopStatus } from "./plugin-loop.service.js";
import { getProjectById } from "../repositories/project.repository.js";
import { getPreference } from "../repositories/preferences.repository.js";
import { insertProjectRepo, listProjectRepos } from "../repositories/repo.repository.js";
import { createSiblingRepoDir } from "./project-repos.service.js";
import { detectRepoInfo } from "./git-info.service.js";
import { createPluginOutputLocationOps } from "./plugin-output-location.service.js";
import {
  deletePluginRow,
  getPluginRowById,
  listPluginEnabledPreferences,
  listPluginRows,
  upsertPluginRow,
  type PluginRow,
} from "../repositories/plugins.repository.js";
import type { CreateIssueInput, CreateIssueResult } from "./issue.service.js";
import type { CreateWorkspaceInput, CreateWorkspaceResult } from "./workspace-internals.js";

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
import {
  looksLikeGitUrl,
  readManifestFromDir,
  resolveInside,
  addToGitInfoExclude,
  isLinkPath,
  removeLink,
} from "./plugin-fs.js";
import { PluginError } from "./plugin-errors.js";
import { fanOutScaffold, scaffoldPlaceholderStatus, requireScaffoldReady } from "./plugin-scaffold.js";
import { createPluginLoopExtras, validatePluginSource } from "./plugin-loop-extras.service.js";
import { getAllPreferencesCached } from "../repositories/preferences.repository.js";
import { resolveStartPolicy } from "./start-policy.service.js";
import type { BoardEvents } from "./board-events.js";
import {
  createPluginViewsRuntime,
  stopAllPluginViews,
  stopAllPluginViewsAsync,
  stopPluginViews,
  type PluginViewProcess,
} from "./plugin-views.service.js";
import { pluginsHomeDir } from "./plugin-fs.js";
import {
  marketplaceCatalogPath,
  buildMarketplaceEntries,
  normalizeGitUrl,
  type PluginMarketplaceEntry,
  type InstalledPluginRow,
} from "./plugin-marketplace.js";
import {
  upsertPluginViewProcess,
  deletePluginViewProcess,
  deletePluginViewProcessesForPlugin,
} from "../repositories/plugin-view-processes.repository.js";

// Re-exported so existing importers keep working after the split. `stopAllPluginViews` is the
// shutdown handler's entry point (`startup/process-handlers.ts`) and several tests import it from
// here; the view child-process map now lives in ONE place, `plugin-views.service.ts`.
export { pluginsHomeDir, marketplaceCatalogPath, stopAllPluginViews, stopAllPluginViewsAsync };
export type { PluginMarketplaceEntry, PluginViewProcess };

export type PluginScriptResult = PluginCommandResult;

export interface EnableReport {
  prefKey: string;
  skills: Array<{ name: string; mode: "junction" | "copy" | "skipped-existing" | "missing-source" }>;
  scaffoldWritten: boolean;
  /** Unfilled `TODO:` markers in the just-written scaffold file (0 when nothing was written). */
  scaffoldPlaceholders: number;
  warnings: string[];
}

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
}

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
    findSidecarRepo,
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
    return {
      row: updated,
      pulled,
      headChanged,
      previousVersion: row.version ?? null,
      version: updated.version ?? null,
      viewsStopped,
    };
  }

  // Short-TTL memo for the plugin listing (#418): GET /api/plugins re-did per-request
  // work per installed plugin — a manifest parse, an output-location pref read, and a
  // manifest-file disk read for the drift check (measured at 5.1s once, likely a cold
  // AV-scanned disk read). The listing only changes through the mutators below, which
  // all clear the memo; the TTL bounds staleness from out-of-band pref edits. Keyed by
  // projectId because the enabled/outputLocation decoration is project-scoped. The
  // in-flight promise is memoized so concurrent requests share one compute; a rejection
  // evicts itself so errors are never cached.
  const LIST_PLUGINS_TTL_MS = 15_000;
  const listPluginsMemo = new Map<string, { at: number; result: ReturnType<typeof computePluginList> }>();

  /**
   * Manifest-drift verdicts keyed by manifest path (#425). Invalidated by the file's own
   * mtime AND by the cached `manifestJson` it was compared against, so a `POST /:id/update`
   * (which rewrites the row, not the file) can never leave a stale "drifted" badge behind.
   * Unbounded only in the number of INSTALLED plugins, which is a handful.
   */
  const manifestDriftCache = new Map<string, { mtimeMs: number; manifestJson: string; drift: boolean }>();

  function listPlugins(projectId?: string) {
    const key = projectId ?? "";
    const memo = listPluginsMemo.get(key);
    if (memo && Date.now() - memo.at < LIST_PLUGINS_TTL_MS) return memo.result;
    const result = computePluginList(projectId);
    listPluginsMemo.set(key, { at: Date.now(), result });
    result.catch(() => listPluginsMemo.delete(key));
    return result;
  }

  /** Wrap a listing-affecting mutator so it clears the listPlugins memo (even on throw —
   *  a partial mutation must not leave a stale listing cached). */
  function invalidatesPluginList<A extends unknown[], R>(fn: (...args: A) => Promise<R>): (...args: A) => Promise<R> {
    return async (...args: A) => {
      try {
        return await fn(...args);
      } finally {
        listPluginsMemo.clear();
      }
    };
  }

  /**
   * Is the manifest the board RUNS (the cached row) behind the one on DISK? Shared by the
   * marketplace listing and the board's plugin panel (#442) — the panel is where an operator
   * actually drives loops, and it used to show nothing, so a drifted plugin ran its stale
   * manifest with the only warning parked in a Settings tab the operator never opens.
   *
   * mtime + cached-manifestJson keyed (#425): skips the read when neither side has moved, and
   * can never report stale drift because a row rewrite (POST /:id/update) invalidates the entry.
   */
  async function readManifestDrift(row: { localPath: string; manifestJson: string }): Promise<boolean> {
    try {
      const manifestPath = join(row.localPath, PLUGIN_MANIFEST_FILENAME);
      const mtimeMs = (await stat(manifestPath)).mtimeMs;
      const cached = manifestDriftCache.get(manifestPath);
      if (cached && cached.mtimeMs === mtimeMs && cached.manifestJson === row.manifestJson) return cached.drift;
      const drift = (await readFile(manifestPath, "utf8")).trim() !== row.manifestJson.trim();
      manifestDriftCache.set(manifestPath, { mtimeMs, manifestJson: row.manifestJson, drift });
      return drift;
    } catch {
      return false; // checkout gone or unreadable — surfaced elsewhere
    }
  }

  async function computePluginList(projectId?: string) {
    const rows = await listPluginRows(database);
    const enabledMap = projectId ? await enabledSlugsByProject() : null;
    const enabledSlugs = enabledMap?.get(projectId!) ?? new Set<string>();
    return Promise.all(rows.map(async (row) => {
      let manifest: PluginManifest | null = null;
      let manifestError: string | null = null;
      try {
        manifest = parsePluginManifest(row.manifestJson);
      } catch (err) {
        manifestError = err instanceof Error ? err.message : String(err);
      }
      // A peek only — never creates the sidecar repo (that happens on enable/run/setOutputLocation).
      const outputLocation = projectId ? await readOutputLocationPref(row.pluginId, projectId) : undefined;
      // Drift (#295): the cached manifest is what the board RUNS; the file on disk is what the
      // author EDITED. They only reconcile on POST /:id/update, and until then edits silently do
      // nothing — so say so instead of letting the author chase a phantom bug.
      // Async read (see readManifestDrift): a sync read of a cold file would stall the
      // whole event loop, and this runs per installed plugin per memo-miss request.
      const manifestDrift = await readManifestDrift(row);
      return {
        ...row,
        manifest,
        manifestError,
        manifestDrift,
        ...(projectId ? { enabled: enabledSlugs.has(row.pluginId), outputLocation } : {}),
      };
    }));
  }

  /**
   * The marketplace = every installed plugin (row + manifest + enabled flag) merged
   * with the machine's catalog file of installable-but-not-installed plugins. A
   * catalog entry matching an installed plugin (by normalized git URL or slug) is
   * absorbed into the installed row rather than listed twice.
   */
  async function listMarketplace(projectId?: string): Promise<{ entries: PluginMarketplaceEntry[]; catalogPath: string }> {
    const rows = (await listPlugins(projectId)) as unknown as InstalledPluginRow[];
    return { entries: buildMarketplaceEntries(rows), catalogPath: marketplaceCatalogPath() };
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
    fanOutScaffold(plugin, outputRepoPath, project.repoPath, project.name, report);
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
    requireScaffoldReady(plugin, outputRepoPath, "scripts");

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
    requireScaffoldReady(plugin, outputRepoPath, "loops");
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
        });
      }
      for (const skill of manifest.skills ?? []) {
        const name = pluginSkillName(skill.dir);
        // `workflow` travels to the UI so the launcher can SEE which workflow the plugin
        // chose for this skill, and change it, instead of discovering it after the fact.
        skills.push({ ...owner, name, description: skill.description ?? null, workflow: skill.workflow ?? null });
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
