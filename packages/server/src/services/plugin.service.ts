import { randomUUID } from "node:crypto";
import net from "node:net";
import { homedir } from "node:os";
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
import {
  PLUGIN_MANIFEST_FILENAME,
  parsePluginManifest,
  pluginEnabledPreferenceKey,
  substitutePluginEnv,
  substitutePluginPlaceholders,
  type PluginManifest,
  type PluginPlaceholderVars,
} from "@agentic-kanban/shared/lib/plugin-manifest";
import { isPluginEnabledPreferenceKey } from "@agentic-kanban/shared/lib/dynamic-preference-keys";
import type { Database } from "../db/index.js";
import { spawnShellCommand, taskkillTree } from "./process-exec.js";
import { getProjectById } from "../repositories/project.repository.js";
import {
  deletePluginRow,
  getPluginRowById,
  listPluginEnabledPreferences,
  listPluginRows,
  upsertPluginRow,
  type PluginRow,
} from "../repositories/plugins.repository.js";

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

export class PluginError extends Error {
  constructor(
    message: string,
    public readonly code: "NOT_FOUND" | "BAD_REQUEST" | "CONFLICT" = "BAD_REQUEST",
  ) {
    super(message);
    this.name = "PluginError";
  }
}

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

export function pluginsHomeDir(): string {
  return process.env.AGENTIC_KANBAN_PLUGINS_DIR || join(homedir(), ".agentic-kanban", "plugins");
}

function looksLikeGitUrl(source: string): boolean {
  return /^(https?:\/\/|git@|ssh:\/\/|git:\/\/)/.test(source);
}

function readManifestFromDir(dir: string): { manifest: PluginManifest; raw: string } {
  const manifestPath = join(dir, PLUGIN_MANIFEST_FILENAME);
  if (!existsSync(manifestPath)) {
    throw new PluginError(`No ${PLUGIN_MANIFEST_FILENAME} found at ${dir}`, "BAD_REQUEST");
  }
  const raw = readFileSync(manifestPath, "utf8");
  try {
    return { manifest: parsePluginManifest(raw), raw };
  } catch (err) {
    // Re-tag as a domain error so the route layer answers 400, not 500.
    throw new PluginError(err instanceof Error ? err.message : String(err), "BAD_REQUEST");
  }
}

/** Resolve a manifest-relative path inside `root`, refusing escapes (defense in depth). */
function resolveInside(root: string, relativePath: string, what: string): string {
  const rootAbs = resolve(root);
  const target = resolve(rootAbs, relativePath);
  if (target !== rootAbs && !target.startsWith(rootAbs + sep)) {
    throw new PluginError(`${what} escapes its root: ${relativePath}`, "BAD_REQUEST");
  }
  return target;
}

/** Idempotently append a line to `<repo>/.git/info/exclude` (skips worktree .git files). */
function addToGitInfoExclude(repoPath: string, line: string): void {
  const gitDir = join(repoPath, ".git");
  try {
    if (!existsSync(gitDir) || !statSync(gitDir).isDirectory()) return;
    const excludePath = join(gitDir, "info", "exclude");
    mkdirSync(dirname(excludePath), { recursive: true });
    const existing = existsSync(excludePath) ? readFileSync(excludePath, "utf8") : "";
    if (existing.split(/\r?\n/).includes(line)) return;
    appendFileSync(excludePath, (existing.endsWith("\n") || existing === "" ? "" : "\n") + line + "\n");
  } catch {
    /* exclude bookkeeping is best-effort */
  }
}

/** True when the path exists and is a symlink/junction (never a real dir). */
function isLinkPath(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

function removeLink(path: string): void {
  try {
    unlinkSync(path);
  } catch {
    // Directory junctions/symlinks on Windows sometimes need rmdir semantics.
    rmdirSync(path);
  }
}

const OUTPUT_TAIL_CAP = 16_384;
const SCRIPT_TIMEOUT_MS = 5 * 60 * 1000;

function tail(text: string): string {
  return text.length > OUTPUT_TAIL_CAP ? text.slice(text.length - OUTPUT_TAIL_CAP) : text;
}

export interface PluginScriptResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export interface EnableReport {
  prefKey: string;
  skills: Array<{ name: string; mode: "junction" | "copy" | "skipped-existing" | "missing-source" }>;
  scaffoldWritten: boolean;
  warnings: string[];
}

export function createPluginService(deps: { database: Database }) {
  const { database } = deps;

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
      if (!isPluginEnabledPreferenceKey(row.key) || row.value !== "true") continue;
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
    return rows.map((row) => {
      let manifest: PluginManifest | null = null;
      let manifestError: string | null = null;
      try {
        manifest = parsePluginManifest(row.manifestJson);
      } catch (err) {
        manifestError = err instanceof Error ? err.message : String(err);
      }
      return {
        ...row,
        manifest,
        manifestError,
        ...(projectId ? { enabled: enabledSlugs.has(row.pluginId) } : {}),
      };
    });
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
      projectName,
      pluginPath: plugin.localPath,
    });
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content, "utf8");
    report.scaffoldWritten = true;
  }

  async function enableForProject(pluginRowId: string, projectId: string): Promise<EnableReport> {
    const plugin = await requirePlugin(pluginRowId);
    const project = await requireProject(projectId);
    const prefKey = pluginEnabledPreferenceKey(plugin.pluginId, projectId);
    await setPreferenceChecked(database, [{ key: prefKey, value: "true" }]);

    const report: EnableReport = { prefKey, skills: [], scaffoldWritten: false, warnings: [] };
    fanOutSkills(plugin, project.repoPath, report);
    fanOutScaffold(plugin, project.repoPath, project.name, report);
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
    const vars: PluginPlaceholderVars = {
      repoPath: project.repoPath,
      projectName: project.name,
      pluginPath: plugin.localPath,
      port,
    };
    const env: Record<string, string> = substitutePluginEnv(view.serve.env, vars);
    if (view.serve.portEnv) env[view.serve.portEnv] = String(port);
    const command = substitutePluginPlaceholders(view.serve.command, vars);

    const child = spawnShellCommand(command, {
      cwd: plugin.localPath,
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

  /** Single HTTP probe — never polls in a loop. */
  async function probeHealth(port: number): Promise<boolean> {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(1500) });
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
    return {
      running: true as const,
      port: entry.port,
      pid: entry.pid,
      startedAt: entry.startedAt,
      url: `http://localhost:${entry.port}`,
      healthy: await probeHealth(entry.port),
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

    const vars: PluginPlaceholderVars = {
      repoPath: project.repoPath,
      projectName: project.name,
      pluginPath: plugin.localPath,
    };
    const cwd = script.cwd === "plugin" ? plugin.localPath : project.repoPath;
    const command = substitutePluginPlaceholders(script.command, vars);
    const env = substitutePluginEnv(script.env, vars);

    return new Promise<PluginScriptResult>((resolveRun, rejectRun) => {
      const child = spawnShellCommand(command, { cwd, stdio: ["ignore", "pipe", "pipe"], mergeEnv: env });
      let stdout = "";
      let stderr = "";
      child.stdout?.on("data", (c: Buffer) => { stdout = tail(stdout + c.toString("utf8")); });
      child.stderr?.on("data", (c: Buffer) => { stderr = tail(stderr + c.toString("utf8")); });
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        if (process.platform === "win32" && child.pid) void taskkillTree(child.pid).catch(() => {});
        try { child.kill(); } catch { /* already gone */ }
        resolveRun({ code: null, stdout, stderr, timedOut: true });
      }, SCRIPT_TIMEOUT_MS);
      timer.unref();
      child.on("error", (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        rejectRun(err);
      });
      child.on("close", (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolveRun({ code, stdout, stderr, timedOut: false });
      });
    });
  }

  return {
    installPlugin,
    listPlugins,
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
  };
}

export type PluginService = ReturnType<typeof createPluginService>;

const singletons = new Map<Database, PluginService>();

/** Memoized per-database singleton, like sibling services' lazy accessors. */
export function getPluginService(database: Database): PluginService {
  let service = singletons.get(database);
  if (!service) {
    service = createPluginService({ database });
    singletons.set(database, service);
  }
  return service;
}
