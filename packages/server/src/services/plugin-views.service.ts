/**
 * Plugin VIEW child-server lifecycle — extracted from `plugin.service.ts` to keep it under the
 * 1000-line god-module ceiling (that gate is part of `verify_script`, so a breach fails the
 * pre-merge gate for every workspace on the board, not just the branch that grew the file).
 *
 * This is the seam the two previous extractions (`plugin-marketplace.ts`, `plugin-view-probe.ts`)
 * deferred: the half of the views concern that owns STATE and the service closure. Everything
 * here is about supervised child processes — allocate a port, spawn the plugin's serve command,
 * track it in the module-level `viewChildren` map, kill it again.
 *
 * The closure-free helpers (`findView`, `probeHealth`) stay in `plugin-view-probe.ts`.
 *
 * IMPORTANT — `viewChildren` is module-level, so this module must be the SINGLE owner of it.
 * `plugin.service.ts` never touches the map directly; it goes through `stopAllPluginViews()` /
 * `stopPluginViews()` and the runtime returned by `createPluginViewsRuntime()`.
 */
import net from "node:net";
import type { ChildProcess } from "node:child_process";
import {
  substitutePluginEnv,
  substitutePluginPlaceholders,
  type PluginManifest,
  type PluginPlaceholderVars,
} from "@agentic-kanban/shared/lib/plugin-manifest";
import { spawnShellCommand, taskkillTree } from "./process-exec.js";
import { tailOutput as tail } from "./plugin-exec.js";
import { findView, probeHealth } from "./plugin-view-probe.js";

/**
 * How long `startView` waits for the child to answer its health probe before returning — #252.
 *
 * The start path used to return `http://localhost:<port>` the instant `spawnShellCommand`
 * returned, and the client sets that as the iframe `src` immediately, so any server needing more
 * than ~100ms to bind (a Vite dev server, a Python dashboard) rendered the browser's
 * ERR_CONNECTION_REFUSED page with no retry. The wait is BOUNDED and non-fatal: a slower server
 * still comes up, it just reports `ready: false` and the caller polls `getViewStatus`.
 */
const DEFAULT_READINESS_TIMEOUT_MS = 15_000;
const READINESS_POLL_MS = 150;

/** Read per call, not at import, so a test (or an operator) can retune it without a restart. */
function readinessTimeoutMs(): number {
  const raw = Number(process.env.PLUGIN_VIEW_READY_TIMEOUT_MS);
  return Number.isFinite(raw) && raw >= 0 ? raw : DEFAULT_READINESS_TIMEOUT_MS;
}

export interface PluginViewStartResult {
  url: string;
  port: number;
  pid: number | null;
  /**
   * True when the child answered its health probe before the deadline. `false` means "still
   * starting" — the process is alive and tracked, so the caller should show a spinner and poll
   * `getViewStatus` rather than frame a URL that is not listening yet.
   */
  ready: boolean;
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

/**
 * In-flight `startView` calls, keyed exactly like `viewChildren` — #251.
 *
 * The double-start guard is a check-then-set with FOUR awaits between the `viewChildren.get(key)`
 * and the matching `set` (plugin row, project row, output repo path, port allocation). Two
 * concurrent starts of one view therefore both saw "not running" and both spawned a server; the
 * second overwrote the map entry and the first child was orphaned FOREVER — its exit handler's
 * `entry?.child === child` guard makes it remove nothing, `stopView` cannot see it and
 * `stopAllPluginViews()` cannot kill it on shutdown.
 *
 * Rather than reserve the slot and kill a loser, the second caller now JOINS the first promise:
 * the key is derivable from the arguments alone, before any await, so there is no window at all
 * and only one child is ever spawned.
 */
const startingViews = new Map<string, Promise<PluginViewStartResult>>();

/**
 * Poll the child's health endpoint until it answers or the deadline passes. Gives up early if the
 * child exited — a server that died has nothing to become ready.
 */
async function waitUntilReady(port: number, healthPath: string | undefined, child: ChildProcess): Promise<boolean> {
  const deadline = Date.now() + readinessTimeoutMs();
  for (;;) {
    if (await probeHealth(port, healthPath)) return true;
    if (child.exitCode !== null || child.killed) return false;
    if (Date.now() >= deadline) return false;
    await new Promise((r) => setTimeout(r, READINESS_POLL_MS));
  }
}

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

/**
 * Kill the supervised view servers belonging to one plugin ROW — optionally narrowed to a single
 * project. Used by uninstall (row is gone), update (`git pull` moved HEAD, so the running child
 * executes stale code) and disable-for-project.
 */
export function stopPluginViews(pluginRowId: string, projectId?: string): number {
  let stopped = 0;
  for (const [key, entry] of viewChildren) {
    if (entry.pluginId !== pluginRowId) continue;
    if (projectId !== undefined && entry.projectId !== projectId) continue;
    killChild(entry);
    viewChildren.delete(key);
    stopped++;
  }
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

type PluginWithManifest = { id: string; pluginId: string; localPath: string; manifest: PluginManifest };
type ProjectLike = { id: string; repoPath: string; name: string };

/**
 * The closure-bound half of the views concern. The collaborators are passed in rather than
 * re-derived so this module needs no database and no repository imports of its own.
 */
export function createPluginViewsRuntime<P extends PluginWithManifest, Pr extends ProjectLike>(deps: {
  requirePlugin: (id: string) => Promise<P>;
  requireProject: (projectId: string) => Promise<Pr>;
  resolveOutputRepoPath: (plugin: P, project: Pr) => Promise<string>;
  /** slug set per project, from the `plugin_enabled_<slug>_<projectId>` prefs. */
  enabledSlugsByProject: () => Promise<Map<string, Set<string>>>;
  /** Installed plugin rows (raw, manifest still JSON — a broken one must not blank the panel). */
  listPluginRows: () => Promise<Array<{ id: string; pluginId: string; name: string; manifestJson: string }>>;
  parseManifest: (manifestJson: string) => PluginManifest;
  /** Externally reachable board API base URL (`{{boardUrl}}`) — resolved by the composition
   *  root, not read from env here, so a worktree server hands out its own URL. */
  boardUrl: string;
  /**
   * Persistence hooks (#228) — this module stays database-free, so the PID bookkeeping that
   * lets the NEXT server generation reap children orphaned by a tsx-watch restart is injected.
   * Both are best-effort: a persistence failure must never fail a view start/stop.
   */
  persistViewProcess?: (values: { pluginRowId: string; viewId: string; projectId: string; pid: number; port: number; command: string }) => Promise<void>;
  dropViewProcess?: (pluginRowId: string, viewId: string, projectId: string) => Promise<void>;
}) {
  const { requirePlugin, requireProject, resolveOutputRepoPath, enabledSlugsByProject, listPluginRows, parseManifest, boardUrl, persistViewProcess, dropViewProcess } = deps;

  async function startView(pluginRowId: string, viewId: string, projectId: string): Promise<PluginViewStartResult> {
    // Serialize per view BEFORE the first await — see `startingViews` (#251).
    const key = viewKey(pluginRowId, viewId, projectId);
    const inFlight = startingViews.get(key);
    if (inFlight) return inFlight;
    const attempt = startViewSerialized(pluginRowId, viewId, projectId);
    startingViews.set(key, attempt);
    try {
      return await attempt;
    } finally {
      if (startingViews.get(key) === attempt) startingViews.delete(key);
    }
  }

  async function startViewSerialized(pluginRowId: string, viewId: string, projectId: string): Promise<PluginViewStartResult> {
    const plugin = await requirePlugin(pluginRowId);
    const project = await requireProject(projectId);
    const view = findView(plugin.manifest, viewId);
    const key = viewKey(pluginRowId, viewId, projectId);

    const existing = viewChildren.get(key);
    if (existing) {
      if (existing.child.exitCode === null && !existing.child.killed) {
        // Already supervised: report its LIVE readiness rather than assuming a running process is
        // serving — a view that died between requests must not be framed as ready.
        return {
          url: `http://localhost:${existing.port}`,
          port: existing.port,
          pid: existing.pid,
          ready: await probeHealth(existing.port, view.serve.healthPath),
        };
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
      boardUrl,
      projectId,
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
      void dropViewProcess?.(pluginRowId, viewId, projectId).catch(() => {});
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
    // Persisted BEFORE the readiness wait so a restart during that window still finds the row —
    // it is what the next server generation's startup reap reads (#228).
    if (child.pid && persistViewProcess) {
      try {
        await persistViewProcess({ pluginRowId, viewId, projectId, pid: child.pid, port, command });
      } catch (err) {
        console.warn(`[plugins] failed to persist view server PID for ${plugin.pluginId}:${viewId} (non-fatal):`, err instanceof Error ? err.message : String(err));
      }
    }
    // Wait for the server to actually LISTEN before reporting the URL as usable (#252). Bounded
    // and non-fatal — the child stays supervised either way, and `ready: false` tells the caller
    // to poll instead of framing a socket that is not accepting connections yet.
    const ready = await waitUntilReady(port, view.serve.healthPath, child);
    if (!ready && (child.exitCode !== null || child.killed)) {
      console.warn(
        `[plugins] view ${plugin.pluginId}:${viewId} exited before it became ready${stderrTail ? `: ${stderrTail.slice(-500)}` : ""}`,
      );
    }
    return { url: `http://localhost:${port}`, port, pid: child.pid ?? null, ready };
  }

  async function stopView(pluginRowId: string, viewId: string, projectId: string): Promise<{ stopped: boolean }> {
    const key = viewKey(pluginRowId, viewId, projectId);
    const entry = viewChildren.get(key);
    if (!entry) return { stopped: false };
    killChild(entry);
    viewChildren.delete(key);
    await dropViewProcess?.(pluginRowId, viewId, projectId).catch(() => {});
    return { stopped: true };
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
    for (const row of await listPluginRows()) {
      if (!enabled.has(row.pluginId)) continue;
      try {
        const manifest = parseManifest(row.manifestJson);
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

  return { startView, stopView, getViewStatus, listViews, listProjectViews };
}
