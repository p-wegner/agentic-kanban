import { randomUUID } from "node:crypto";
import net from "node:net";
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
import type { ChildProcess } from "node:child_process";
import { gitExecOrThrow } from "@agentic-kanban/shared/lib/git-exec";
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
  substitutePluginEnv,
  substitutePluginPlaceholders,
  type PluginManifest,
  type PluginOutputLocation,
  type PluginPlaceholderVars,
} from "@agentic-kanban/shared/lib/plugin-manifest";
import { isPluginEnabledPreferenceKey } from "@agentic-kanban/shared/lib/dynamic-preference-keys";
import { parseBoolSetting } from "@agentic-kanban/shared/lib/settings-registry";
import type { Database } from "../db/index.js";
import { spawnShellCommand, taskkillTree } from "./process-exec.js";
import { runPluginCommand, tailOutput as tail, type PluginCommandResult } from "./plugin-exec.js";
import { createPluginLoopEngine, type LoopAdvanceResult, type LoopStatus } from "./plugin-loop.service.js";
import { getProjectById } from "../repositories/project.repository.js";
import { getPreference } from "../repositories/preferences.repository.js";
import { insertProjectRepo, listProjectRepos } from "../repositories/repo.repository.js";
import { createSiblingRepoDir } from "./project-repos.service.js";
import { detectRepoInfo } from "./git-info.service.js";
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
import { pluginsHomeDir } from "./plugin-fs.js";
import {
  marketplaceCatalogPath,
  buildMarketplaceEntries,
  type PluginMarketplaceEntry,
  type InstalledPluginRow,
} from "./plugin-marketplace.js";

// Re-exported so existing importers keep working after the split.
export { pluginsHomeDir, marketplaceCatalogPath };
export type { PluginMarketplaceEntry };


export interface PluginViewProcess {
  child: ChildProcess;
  port: number;
  pid: number | null;
  startedAt: string;
  pluginId: string;
  viewId: string;
  projectId: string;
}

/**
 * Module-level so `stopAllPluginViews()` (called from the shutdown handler) needs
 * no service/db instance. Keyed `pluginRowId:viewId:projectId`.
 */
const viewChildren = new Map<string, PluginViewProcess>();

function viewKey(pluginRowId: string, viewId: string, projectId: string): string {
  return `${pluginRowId}:${viewId}:${projectId}`;
}

function killChild(entry: PluginViewProcess): void {
  // The child is a cmd.exe/sh wrapper; on Windows kill the tree so the actual
  // server (a grandchild) dies too. Never touches anything but this exact pid.
  if (process.platform === "win32" && entry.pid) {
    void taskkillTree(entry.pid).catch(() => {});
  }
  try {
    entry.child.kill();
  } catch {
    /* already gone */
  }
}

/** Kill every supervised plugin-view server. Called from the server shutdown path. */
export function stopAllPluginViews(): number {
  let stopped = 0;
  for (const entry of viewChildren.values()) {
    killChild(entry);
    stopped++;
  }
  viewChildren.clear();
  return stopped;
}

/** OS-assigned free port: bind to 0, read, close. Never guesses a number. */
function allocateFreePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => (port > 0 ? resolvePort(port) : reject(new Error("failed to allocate a port"))));
    });
  });
}


export type PluginScriptResult = PluginCommandResult;

export interface EnableReport {
  prefKey: string;
  skills: Array<{ name: string; mode: "junction" | "copy" | "skipped-existing" | "missing-source" }>;
  scaffoldWritten: boolean;
  /** Unfilled `TODO:` markers in the just-written scaffold file (0 when nothing was written). */
  scaffoldPlaceholders: number;
  warnings: string[];
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
}) {
  const { database, createIssue, createWorkspace } = deps;
  const loops = createPluginLoopEngine({ database, createIssue });

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

  async function installPlugin(input: { source: string }): Promise<PluginRow> {
    const source = typeof input.source === "string" ? input.source.trim() : "";
    if (!source) throw new PluginError("source is required", "BAD_REQUEST");

    let localPath: string;
    let sourceUrl: string | null = null;
    if (existsSync(source) && statSync(source).isDirectory()) {
      localPath = resolve(source);
    } else if (looksLikeGitUrl(source)) {
      sourceUrl = source;
      const repoName = (basename(source).replace(/\.git$/i, "") || "plugin").toLowerCase();
      localPath = join(pluginsHomeDir(), repoName);
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

  async function listPlugins(projectId?: string) {
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
      return {
        ...row,
        manifest,
        manifestError,
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
    for (const [key, entry] of viewChildren) {
      if (entry.pluginId !== id) continue;
      killChild(entry);
      viewChildren.delete(key);
    }
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
      const name = basename(skill.dir.replace(/\\/g, "/"));
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

  function fanOutScaffold(
    plugin: PluginRow & { manifest: PluginManifest },
    repoPath: string,
    leadingRepoPath: string,
    projectName: string,
    report: EnableReport,
  ) {
    const scaffold = plugin.manifest.scaffold;
    if (!scaffold) return;
    const target = resolveInside(repoPath, scaffold.targetPath, `scaffold targetPath "${scaffold.targetPath}"`);
    if (existsSync(target)) return;
    const templatePath = resolveInside(plugin.localPath, scaffold.profileTemplate, "scaffold profileTemplate");
    if (!existsSync(templatePath)) {
      report.warnings.push(`scaffold template not found in plugin: ${scaffold.profileTemplate}`);
      return;
    }
    const content = substitutePluginPlaceholders(readFileSync(templatePath, "utf8"), {
      repoPath,
      leadingRepoPath,
      projectName,
      pluginPath: plugin.localPath,
    });
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content, "utf8");
    report.scaffoldWritten = true;
    report.scaffoldPlaceholders = countScaffoldPlaceholders(content);
    if (report.scaffoldPlaceholders > 0) {
      report.warnings.push(
        `scaffold written — ${report.scaffoldPlaceholders} placeholder${report.scaffoldPlaceholders === 1 ? "" : "s"} `
        + `need filling in ${scaffold.targetPath} before this plugin's scripts/loops will run`,
      );
    }
  }

  /**
   * Live readiness of a plugin's scaffold file (not the write-time snapshot in
   * `EnableReport` — the human may fill it in any time after enable). Returns
   * `null` when the plugin declares no scaffold, or the file doesn't exist yet
   * (nothing to gate on until it's written).
   */
  function scaffoldPlaceholderStatus(
    plugin: PluginRow & { manifest: PluginManifest },
    repoPath: string,
  ): { targetPath: string; remaining: number } | null {
    const scaffold = plugin.manifest.scaffold;
    if (!scaffold) return null;
    const target = resolveInside(repoPath, scaffold.targetPath, `scaffold targetPath "${scaffold.targetPath}"`);
    if (!existsSync(target)) return null;
    return { targetPath: scaffold.targetPath, remaining: countScaffoldPlaceholders(readFileSync(target, "utf8")) };
  }

  /** Throws a clear, actionable error instead of letting a script/loop fail on unfilled scaffold TODOs. */
  function requireScaffoldReady(
    plugin: PluginRow & { manifest: PluginManifest },
    repoPath: string,
    action: "scripts" | "loops",
  ): void {
    const status = scaffoldPlaceholderStatus(plugin, repoPath);
    if (!status || status.remaining === 0) return;
    throw new PluginError(
      `Scaffold "${status.targetPath}" still has ${status.remaining} unresolved TODO: placeholder${status.remaining === 1 ? "" : "s"} `
      + `— fill them in before running this plugin's ${action}.`,
      "CONFLICT",
    );
  }

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

  async function enableForProject(pluginRowId: string, projectId: string): Promise<EnableReport> {
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
    for (const [key, entry] of viewChildren) {
      if (entry.pluginId !== pluginRowId || entry.projectId !== projectId) continue;
      killChild(entry);
      viewChildren.delete(key);
    }

    // Remove skill JUNCTIONS only — a path that is a real directory (copy fallback
    // or a pre-existing project skill) is NEVER deleted.
    const skillsRemoved: string[] = [];
    for (const skill of plugin.manifest.skills ?? []) {
      const name = basename(skill.dir.replace(/\\/g, "/"));
      const target = join(project.repoPath, ".claude", "skills", name);
      if (!isLinkPath(target)) continue;
      removeLink(target);
      skillsRemoved.push(name);
    }
    return { prefKey, skillsRemoved };
  }

  async function getButlerFragments(projectId: string): Promise<string[]> {
    const enabled = (await enabledSlugsByProject()).get(projectId);
    if (!enabled || enabled.size === 0) return [];
    let project: { repoPath: string; name: string } | null = null;
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
        if (!manifest.butler?.promptFragment) continue;
        const fragmentPath = resolveInside(row.localPath, manifest.butler.promptFragment, "butler.promptFragment");
        if (!existsSync(fragmentPath)) continue;
        const text = substitutePluginPlaceholders(readFileSync(fragmentPath, "utf8"), {
          repoPath: project.repoPath,
          leadingRepoPath: project.repoPath,
          projectName: project.name,
          pluginPath: row.localPath,
        }).trim();
        if (text) fragments.push(`## Plugin: ${row.name}\n\n${text}`);
      } catch {
        /* a broken plugin must never take the butler down */
      }
    }
    return fragments;
  }

  function findView(manifest: PluginManifest, viewId: string) {
    const view = (manifest.views ?? []).find((v) => v.id === viewId);
    if (!view) throw new PluginError(`View "${viewId}" not found in plugin manifest`, "NOT_FOUND");
    return view;
  }

  async function startView(pluginRowId: string, viewId: string, projectId: string): Promise<{ url: string; port: number; pid: number | null }> {
    const plugin = await requirePlugin(pluginRowId);
    const project = await requireProject(projectId);
    const view = findView(plugin.manifest, viewId);
    const key = viewKey(pluginRowId, viewId, projectId);

    const existing = viewChildren.get(key);
    if (existing) {
      if (existing.child.exitCode === null && !existing.child.killed) {
        return { url: `http://localhost:${existing.port}`, port: existing.port, pid: existing.pid };
      }
      viewChildren.delete(key);
    }

    const port = await allocateFreePort();
    const outputRepoPath = await resolveOutputRepoPath(plugin, project);
    const vars: PluginPlaceholderVars = {
      repoPath: outputRepoPath,
      leadingRepoPath: project.repoPath,
      projectName: project.name,
      pluginPath: plugin.localPath,
      port,
    };
    const env: Record<string, string> = substitutePluginEnv(view.serve.env, vars);
    if (view.serve.portEnv) env[view.serve.portEnv] = String(port);
    const command = substitutePluginPlaceholders(view.serve.command, vars);

    const child = spawnShellCommand(command, {
      cwd: view.serve.cwd === "repo" ? outputRepoPath : plugin.localPath,
      stdio: ["ignore", "ignore", "pipe"],
      mergeEnv: env,
    });
    let stderrTail = "";
    child.stderr?.on("data", (chunk: Buffer) => {
      stderrTail = tail(stderrTail + chunk.toString("utf8"));
    });
    child.on("exit", (code) => {
      const entry = viewChildren.get(key);
      if (entry?.child === child) viewChildren.delete(key);
      if (code !== 0 && code !== null) {
        console.warn(`[plugins] view ${plugin.pluginId}:${viewId} exited with code ${code}${stderrTail ? `: ${stderrTail.slice(-500)}` : ""}`);
      }
    });

    viewChildren.set(key, {
      child,
      port,
      pid: child.pid ?? null,
      startedAt: new Date().toISOString(),
      pluginId: pluginRowId,
      viewId,
      projectId,
    });
    return { url: `http://localhost:${port}`, port, pid: child.pid ?? null };
  }

  async function stopView(pluginRowId: string, viewId: string, projectId: string): Promise<{ stopped: boolean }> {
    const key = viewKey(pluginRowId, viewId, projectId);
    const entry = viewChildren.get(key);
    if (!entry) return { stopped: false };
    killChild(entry);
    viewChildren.delete(key);
    return { stopped: true };
  }

  /**
   * Single HTTP probe — never polls in a loop. Tries `healthPath` (default "/health") first;
   * a 404 there falls back to "/" so a plugin with no dedicated health endpoint still works.
   */
  async function probeHealth(port: number, healthPath = "/health"): Promise<boolean> {
    // readiness probe against a PLUGIN's supervised child view-server process
    // (spawnShellCommand, above), not this board server — a genuinely separate process
    // on a dynamically allocated port with no in-process function to inject.
    // SELF-HTTP OK: see server/CLAUDE.md "Self-HTTP calls are an anti-pattern".
    const path = healthPath.startsWith("/") ? healthPath : `/${healthPath}`;
    try {
      const res = await fetch(`http://127.0.0.1:${port}${path}`, { signal: AbortSignal.timeout(1500) });
      if (res.status === 404 && path !== "/") {
        const fallback = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(1500) });
        return fallback.status < 500;
      }
      return res.status < 500;
    } catch {
      return false;
    }
  }

  async function getViewStatus(pluginRowId: string, viewId: string, projectId: string) {
    const entry = viewChildren.get(viewKey(pluginRowId, viewId, projectId));
    if (!entry || entry.child.exitCode !== null) {
      return { running: false as const };
    }
    const plugin = await requirePlugin(pluginRowId);
    const view = findView(plugin.manifest, viewId);
    return {
      running: true as const,
      port: entry.port,
      pid: entry.pid,
      startedAt: entry.startedAt,
      url: `http://localhost:${entry.port}`,
      healthy: await probeHealth(entry.port, view.serve.healthPath),
    };
  }

  /** View descriptors + running state for one plugin (route: GET /plugins/:id/views). */
  async function listViews(pluginRowId: string, projectId: string) {
    const plugin = await requirePlugin(pluginRowId);
    await requireProject(projectId);
    const views = [];
    for (const view of plugin.manifest.views ?? []) {
      views.push({ id: view.id, label: view.label, kind: view.kind, ...(await getViewStatus(pluginRowId, view.id, projectId)) });
    }
    return views;
  }

  /** Flat list of the ENABLED plugins' views for a project (the client view host). */
  async function listProjectViews(projectId: string) {
    await requireProject(projectId);
    const enabled = (await enabledSlugsByProject()).get(projectId) ?? new Set<string>();
    const out = [];
    for (const row of await listPluginRows(database)) {
      if (!enabled.has(row.pluginId)) continue;
      try {
        const manifest = parsePluginManifest(row.manifestJson);
        for (const view of manifest.views ?? []) {
          out.push({
            pluginId: row.id,
            pluginSlug: row.pluginId,
            pluginName: row.name,
            id: view.id,
            label: view.label,
            kind: view.kind,
            ...(await getViewStatus(row.id, view.id, projectId)),
          });
        }
      } catch {
        /* skip plugins with a broken cached manifest */
      }
    }
    return out;
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
    const skillDef = (plugin.manifest.skills ?? []).find((s) => s.dir.split("/").pop() === skillName);
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
    const skillDef = (plugin.manifest.skills ?? []).find((s) => s.dir.split("/").pop() === loopDef?.skill);
    const workflowTemplateId = await resolveWorkflowTemplateId(
      projectId,
      loopDef?.workflow ?? skillDef?.workflow,
    );
    return loops.advanceLoop({
      manifest: plugin.manifest,
      pluginSlug: plugin.pluginId,
      pluginLocalPath: plugin.localPath,
      loopName,
      projectId,
      projectName: project.name,
      repoPath: outputRepoPath,
      leadingRepoPath: project.repoPath,
      workflowTemplateId,
    });
  }

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
    for (const row of await listPluginRows(database)) {
      if (!enabled.has(row.pluginId)) continue;
      let manifest: PluginManifest;
      try {
        manifest = parsePluginManifest(row.manifestJson);
      } catch {
        continue; // a broken cached manifest must not blank the whole panel
      }
      const owner = { pluginId: row.id, pluginSlug: row.pluginId, pluginName: row.name };
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
        const name = skill.dir.split("/").pop() || skill.dir;
        // `workflow` travels to the UI so the launcher can SEE which workflow the plugin
        // chose for this skill, and change it, instead of discovering it after the fact.
        skills.push({ ...owner, name, description: skill.description ?? null, workflow: skill.workflow ?? null });
      }
    }
    return { views, loops: projectLoops, scripts, skills };
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

  return {
    installPlugin,
    listPlugins,
    listMarketplace,
    listLoops,
    listProjectLoops,
    listProjectSurface,
    advanceLoop,
    setLoopPaused,
    removePlugin,
    enableForProject,
    disableForProject,
    getButlerFragments,
    listViews,
    listProjectViews,
    startView,
    stopView,
    getViewStatus,
    runScript,
    runSkill,
    getOutputLocation,
    setOutputLocation,
  };
}

export type PluginService = ReturnType<typeof createPluginService>;

const singletons = new Map<Database, PluginService>();
const singletonDeps = new Map<Database, PluginServiceSkillDeps>();

export interface PluginServiceSkillDeps {
  createIssue?: (input: CreateIssueInput) => Promise<CreateIssueResult>;
  createWorkspace?: (input: CreateWorkspaceInput) => Promise<CreateWorkspaceResult>;
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
  };
  const gainedDeps = merged.createIssue !== known.createIssue || merged.createWorkspace !== known.createWorkspace;

  let service = singletons.get(database);
  if (!service || gainedDeps) {
    service = createPluginService({ database, ...merged });
    singletons.set(database, service);
    singletonDeps.set(database, merged);
  }
  return service;
}
