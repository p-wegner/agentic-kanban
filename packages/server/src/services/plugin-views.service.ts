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
import { readBoardEnv } from "../lib/env-registry.js";
import net from "node:net";
import type { ChildProcess } from "node:child_process";
import {
  buildPluginPlaceholderVars,
  substitutePluginEnv,
  substitutePluginPlaceholders,
  type PluginManifest,
} from "@agentic-kanban/shared/lib/plugin-manifest";
import { spawnShellCommand, killProcessTree } from "./process-exec.js";
import { tailOutput as tail } from "./plugin-exec.js";
import { findView, probeHealth } from "./plugin-view-probe.js";
import type { EnabledPlugin } from "./plugin-enabled.js";
// Type-only (erased at compile time, `tsPreCompilationDeps: false`), so the "no database and
// no repository imports" property of this module still holds: `PluginViewRef` is the named
// `(pluginRowId, viewId, projectId)` identity, declared at the layer that owns its unique index.
import type { PluginViewRef } from "../repositories/plugin-view-processes.repository.js";
import { errorMessage } from "@agentic-kanban/shared/lib/error-message";

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
  const raw = Number(readBoardEnv("KANBAN_PLUGIN_VIEW_READY_TIMEOUT_MS"));
  return Number.isFinite(raw) && raw >= 0 ? raw : DEFAULT_READINESS_TIMEOUT_MS;
}

/** Re-exported so the views concern is where service-side consumers get it from (#766). */
export type { PluginViewRef };

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
 * Every pid this process has ever spawned as a view server (#352).
 *
 * `viewChildren` is not sufficient to guarantee cleanup: the tracked child is a `cmd.exe`/`sh`
 * WRAPPER and the real server is a grandchild, and the wrapper's `exit` handler drops the map
 * entry — so a grandchild that outlives its wrapper becomes invisible to `stopAllPluginViews*`
 * and nothing ever kills it. Measured consequence: 22 live orphaned `node serve.mjs` processes,
 * each holding a port and its cwd (a fixture temp dir, hence 330 undeletable directories).
 * Keeping the pid means the awaited shutdown/teardown sweep can still reach the tree.
 */
const spawnedViewPids = new Set<number>();

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

function viewKey({ pluginRowId, viewId, projectId }: PluginViewRef): string {
  return `${pluginRowId}:${viewId}:${projectId}`;
}

/**
 * A kill that could not kill (#832).
 *
 * Every call below used to end in `.catch(() => {})`, and that empty catch is exactly why the
 * win32-only `taskkillTree` calls survived undetected: off Windows `taskkill` does not exist,
 * every kill failed with ENOENT, and NOTHING said so — a Linux board simply never killed a
 * plugin view server. Silence is what made a portability bug indistinguishable from success,
 * so the failure now leaves a `[plugins]` line.
 *
 * "Already gone" is NOT a failure and stays quiet. Both kill paths race the child's own exit
 * BY DESIGN — the `exit` handler kills the tree of a pid that just exited, and shutdown kills
 * pids whose servers may have stopped hours ago — so ESRCH (POSIX) and `taskkill`'s "not
 * found" (Windows) are the expected outcome, not an incident. Warning on them would put lines
 * on every normal shutdown and teach the reader to ignore the tag, which is the same failure
 * mode as swallowing, one step further along.
 */
function reportKillFailure(pid: number, err: unknown): void {
  const message = errorMessage(err);
  if (/ESRCH|not found|no such process/i.test(message)) return;
  console.warn(`[plugins] failed to kill view server tree for PID ${pid} (non-fatal): ${message}`);
}

function killChild(entry: PluginViewProcess): void {
  // The child is a cmd.exe/sh wrapper; kill the tree so the actual server (a grandchild on
  // Windows) dies too. Never touches anything but this exact pid. UNBRANCHED since #832: the
  // platform decision lives in `killProcessTree`, so POSIX kills the pid instead of doing
  // nothing at all, and one mocked seam asserts this site on both platforms.
  if (entry.pid) {
    const pid = entry.pid;
    void killProcessTree(pid).catch((err) => reportKillFailure(pid, err));
  }
  try {
    entry.child.kill();
  } catch {
    /* already gone */
  }
}

/**
 * Awaitable, tree-complete kill (#352).
 *
 * `killChild` above `void`s the taskkill and returns synchronously, so a caller that is about to
 * exit the process — or to delete the child's cwd — races it. On Windows the tracked pid is the
 * `cmd.exe` wrapper and the real server is a GRANDCHILD, so `child.kill()` alone reparents the
 * server instead of killing it. That is how 22 orphaned `node serve.mjs` processes and 330 stale
 * `plugin-test-plugin-*` temp directories accumulated: the orphan holds its temp dir as cwd, so
 * the directory removal fails with EBUSY and is swallowed as "best effort".
 */
async function killChildAsync(entry: PluginViewProcess): Promise<void> {
  if (entry.pid) {
    const pid = entry.pid;
    await killProcessTree(pid).catch((err) => reportKillFailure(pid, err));
  }
  try {
    entry.child.kill();
  } catch {
    /* already gone */
  }
}

/**
 * Kill every supervised plugin-view server and WAIT for the tree kills to complete.
 * Use this wherever the caller's next action depends on the children actually being dead —
 * process shutdown, and test teardown that then removes the child's working directory.
 */
export async function stopAllPluginViewsAsync(): Promise<number> {
  const entries = [...viewChildren.values()];
  viewChildren.clear();
  await Promise.all(entries.map((entry) => killChildAsync(entry)));
  // Then sweep every pid we ever spawned, including wrappers whose exit handler already dropped
  // their map entry while a grandchild survived. This is the half that actually removes the
  // orphan class; the loop above only covers children still tracked.
  const strays = [...spawnedViewPids];
  spawnedViewPids.clear();
  // #832: this sweep used to be win32-only, so on Linux the orphan class it exists to remove
  // was never removed at all — the stray pids were collected, cleared, and forgotten.
  await Promise.all(strays.map((pid) => killProcessTree(pid).catch((err) => reportKillFailure(pid, err))));
  return entries.length;
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
  /** #552: the one enabled-plugin iterator; injected so this module stays database-free. */
  listEnabledPlugins: (projectId: string) => Promise<EnabledPlugin[]>;
  /** Installed plugin rows (raw, manifest still JSON — a broken one must not blank the panel). */
  /** Externally reachable board API base URL (`{{boardUrl}}`) — resolved by the composition
   *  root, not read from env here, so a worktree server hands out its own URL. */
  boardUrl: string;
  /**
   * Persistence hooks (#228) — this module stays database-free, so the PID bookkeeping that
   * lets the NEXT server generation reap children orphaned by a tsx-watch restart is injected.
   * Both are best-effort: a persistence failure must never fail a view start/stop.
   */
  persistViewProcess?: (values: PluginViewRef & { pid: number; port: number; command: string }) => Promise<void>;
  dropViewProcess?: (ref: PluginViewRef) => Promise<void>;
}) {
  const { requirePlugin, requireProject, resolveOutputRepoPath, listEnabledPlugins, boardUrl, persistViewProcess, dropViewProcess } = deps;

  async function startView(ref: PluginViewRef): Promise<PluginViewStartResult> {
    // Serialize per view BEFORE the first await — see `startingViews` (#251).
    const key = viewKey(ref);
    const inFlight = startingViews.get(key);
    if (inFlight) return inFlight;
    const attempt = startViewSerialized(ref);
    startingViews.set(key, attempt);
    try {
      return await attempt;
    } finally {
      if (startingViews.get(key) === attempt) startingViews.delete(key);
    }
  }

  async function startViewSerialized(ref: PluginViewRef): Promise<PluginViewStartResult> {
    const { pluginRowId, viewId, projectId } = ref;
    const plugin = await requirePlugin(pluginRowId);
    const project = await requireProject(projectId);
    const view = findView(plugin.manifest, viewId);
    const key = viewKey(ref);

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
    const vars = buildPluginPlaceholderVars({
      outputRepoPath,
      leadingRepoPath: project.repoPath,
      projectName: project.name,
      pluginPath: plugin.localPath,
      port,
      boardUrl,
      projectId,
    });
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
      // #352 — the tracked child is a `cmd.exe`/`sh` WRAPPER; the real server is a grandchild.
      // When the wrapper exits, the grandchild can survive as a reparented orphan — and since the
      // line above just dropped the map entry, `stopAllPluginViews*` can no longer see it, so
      // NOTHING would ever kill it. It then holds a port and its cwd (a temp dir for a test
      // fixture) indefinitely: measured 22 live `node serve.mjs` orphans and 330 undeletable temp
      // dirs. Kill the tree of the pid we recorded, on the way out. Harmless if we are the ones
      // who killed it — a kill on a dead pid just fails, and "already gone" is not reported.
      // Unbranched since #832; POSIX reaches the pid we recorded, which for `sh -c "<cmd>"` is
      // usually the server itself (sh execs the last command), so this is the POSIX analogue
      // of the tree kill rather than a no-op.
      if (child.pid) {
        const pid = child.pid;
        void killProcessTree(pid).catch((err) => reportKillFailure(pid, err));
      }
      void dropViewProcess?.(ref).catch(() => {});
      if (code !== 0 && code !== null) {
        console.warn(`[plugins] view ${plugin.pluginId}:${viewId} exited with code ${code}${stderrTail ? `: ${stderrTail.slice(-500)}` : ""}`);
      }
    });

    if (child.pid) spawnedViewPids.add(child.pid);
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
        console.warn(`[plugins] failed to persist view server PID for ${plugin.pluginId}:${viewId} (non-fatal):`, errorMessage(err));
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

  async function stopView(ref: PluginViewRef): Promise<{ stopped: boolean }> {
    const key = viewKey(ref);
    const entry = viewChildren.get(key);
    if (!entry) return { stopped: false };
    // AWAITED (#352): `stopView` is already async and every caller awaits it, so there is no
    // reason to fire-and-forget the tree kill — and doing so meant a caller that exits right
    // afterwards (a test's last statement, a CLI) took the pending `taskkill` down with it and
    // left the grandchild server alive. That is one of the two ways the orphan class arose.
    await killChildAsync(entry);
    if (entry.pid) spawnedViewPids.delete(entry.pid);
    viewChildren.delete(key);
    await dropViewProcess?.(ref).catch(() => {});
    return { stopped: true };
  }

  async function getViewStatus(ref: PluginViewRef) {
    const entry = viewChildren.get(viewKey(ref));
    if (!entry || entry.child.exitCode !== null) {
      return { running: false as const };
    }
    const plugin = await requirePlugin(ref.pluginRowId);
    const view = findView(plugin.manifest, ref.viewId);
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
      views.push({ id: view.id, label: view.label, kind: view.kind, ...(await getViewStatus({ pluginRowId, viewId: view.id, projectId })) });
    }
    return views;
  }

  /** Flat list of the ENABLED plugins' views for a project (the client view host). */
  async function listProjectViews(projectId: string) {
    await requireProject(projectId);
    const out = [];
    for (const { row, manifest, owner } of await listEnabledPlugins(projectId)) {
      try {
        for (const view of manifest.views ?? []) {
          out.push({
            ...owner,
            id: view.id,
            label: view.label,
            kind: view.kind,
            ...(await getViewStatus({ pluginRowId: row.id, viewId: view.id, projectId })),
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
