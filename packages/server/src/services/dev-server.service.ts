// Per-stack dev-server capability (#790) — boot ANY driven project headlessly to
// confirm it runs, derived from the project's stack profile (#786) with per-project
// `dev_command` / `health_url` preference overrides.
//
// The legacy `dev-server` skill hard-coded this app's own monorepo scheme
// (3001/5173 + Vite/Hono worktree port math). That works for agentic-kanban but
// nothing else. This service generalizes it: the start command, health URL, and
// port all come from the resolved plan, so the board (and builders) can start +
// health-check a node web app, a python service, a go server, etc.
//
// Three primitives, all best-effort and injectable for tests:
//   - resolveDevServerPlan: pure — derive { command, healthUrl, port } from
//     prefs > profile > app worktree-port convention.
//   - startDevServer: spawn the command headless + windowsHide + detached, log to file.
//   - healthCheckDevServer: poll the health URL until it answers (bounded), no port-scan.
//   - stopDevServer: kill ONLY the resolved port's listener (reuses killProcessesOnPorts) —
//     never all node, never a range.

import { spawn } from "node:child_process";
import { openSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { StackProfile } from "@agentic-kanban/shared";
import type { Database } from "../db/index.js";
import { getPreference } from "../repositories/preferences.repository.js";
import { getStackProfile } from "./stack-profile.service.js";
import { killProcessesOnPorts } from "./process-cleanup.js";
import { resolveWorktreeDevPorts } from "./worktree-ports.js";

/** Per-project preference keys for explicit dev-server overrides. */
export function devCommandPrefKey(projectId: string): string {
  return `dev_command_${projectId}`;
}
export function healthUrlPrefKey(projectId: string): string {
  return `health_url_${projectId}`;
}

/** A fully-resolved plan for booting + health-checking a project's dev server. */
export interface DevServerPlan {
  /** Shell command that starts the dev server (e.g. "pnpm dev", "uvicorn app:app"). */
  command: string;
  /** URL to poll to confirm the server is up, or null when it isn't a web project. */
  healthUrl: string | null;
  /** TCP port the server binds (for targeted teardown), or null when unknown. */
  port: number | null;
  /** Whether this project serves an HTTP endpoint at all. */
  isWeb: boolean;
  /** Where each field came from, for debuggability. */
  source: {
    command: "pref" | "profile" | "none";
    healthUrl: "pref" | "profile" | "worktree-port" | "none";
    port: "pref" | "profile" | "worktree-port" | "none";
  };
}

/** Extract a port number from an http(s) URL, or null. */
function portFromUrl(url: string): number | null {
  try {
    const u = new URL(url);
    if (u.port) {
      const p = Number(u.port);
      return Number.isInteger(p) && p > 0 && p < 65536 ? p : null;
    }
    // Implicit ports for the common schemes.
    if (u.protocol === "http:") return 80;
    if (u.protocol === "https:") return 443;
    return null;
  } catch {
    return null;
  }
}

export interface ResolveDevServerPlanInput {
  profile?: StackProfile | null;
  /** Explicit per-project override of the start command. */
  devCommandOverride?: string | null;
  /** Explicit per-project override of the health URL. */
  healthUrlOverride?: string | null;
  /**
   * Absolute path the server will run in. When this is one of the app's own
   * worktrees, the deterministic 3001+N/5173+N convention supplies the port +
   * health URL the worktree dev server actually binds — covers agentic-kanban
   * itself, which the static profile can't know the worktree-shifted port of.
   */
  workingDir?: string | null;
}

/**
 * Pure resolver: derive a dev-server boot plan from (in precedence order)
 *   1. explicit `dev_command` / `health_url` preferences,
 *   2. the persisted stack profile (`devCommand`, `devHealthUrl`, `devPort`),
 *   3. this app's worktree-port convention (only when `workingDir` is a worktree).
 *
 * Returns null only when there is no command to run at all (no override, no
 * profile devCommand) — a project with a command but no health URL is still a
 * valid plan (a CLI/headless service we can start but can't HTTP-probe).
 */
export function resolveDevServerPlan(input: ResolveDevServerPlanInput): DevServerPlan | null {
  const { profile, devCommandOverride, healthUrlOverride, workingDir } = input;

  const commandPref = devCommandOverride?.trim() || "";
  const command = commandPref || profile?.devCommand?.trim() || "";
  if (!command) return null; // nothing to boot

  const worktreePorts = workingDir ? resolveWorktreeDevPorts(workingDir) : null;

  // Health URL precedence: explicit pref > profile > worktree convention.
  const healthPref = healthUrlOverride?.trim() || "";
  let healthUrl: string | null = null;
  let healthUrlSource: DevServerPlan["source"]["healthUrl"] = "none";
  if (healthPref) {
    healthUrl = healthPref;
    healthUrlSource = "pref";
  } else if (profile?.devHealthUrl) {
    healthUrl = profile.devHealthUrl;
    healthUrlSource = "profile";
  } else if (worktreePorts) {
    healthUrl = `http://127.0.0.1:${worktreePorts.serverPort}/api/projects`;
    healthUrlSource = "worktree-port";
  }

  // Port precedence: from the chosen health URL (so it always matches what we
  // probe) > profile.devPort > worktree convention.
  let port: number | null = null;
  let portSource: DevServerPlan["source"]["port"] = "none";
  const portFromHealth = healthUrl ? portFromUrl(healthUrl) : null;
  if (portFromHealth != null) {
    port = portFromHealth;
    portSource = healthUrlSource === "pref" ? "pref" : healthUrlSource === "profile" ? "profile" : "worktree-port";
  } else if (profile?.devPort != null) {
    port = profile.devPort;
    portSource = "profile";
  } else if (worktreePorts) {
    port = worktreePorts.serverPort;
    portSource = "worktree-port";
  }

  const isWeb = Boolean(profile?.isWeb) || Boolean(healthUrl);

  return {
    command,
    healthUrl,
    port,
    isWeb,
    source: {
      command: commandPref ? "pref" : "profile",
      healthUrl: healthUrlSource,
      port: portSource,
    },
  };
}

/**
 * Resolve a project's dev-server plan from its persisted stack profile + prefs.
 * Reads the `dev_command_<id>` / `health_url_<id>` overrides and the stack profile,
 * then delegates to the pure resolver. Returns null when nothing can boot.
 */
export async function resolveProjectDevServerPlan(
  projectId: string,
  database: Database,
  options?: { workingDir?: string | null; profile?: StackProfile | null },
): Promise<DevServerPlan | null> {
  const [devCommandOverride, healthUrlOverride] = await Promise.all([
    getPreference(devCommandPrefKey(projectId), database),
    getPreference(healthUrlPrefKey(projectId), database),
  ]);
  const profile = options?.profile ?? (await getStackProfile(projectId, database));
  return resolveDevServerPlan({
    profile,
    devCommandOverride,
    healthUrlOverride,
    workingDir: options?.workingDir,
  });
}

export interface StartDevServerResult {
  pid: number | null;
  logPath: string;
  command: string;
}

export interface StartDevServerDeps {
  spawnImpl?: typeof spawn;
  openLog?: (path: string) => number;
}

/**
 * Start a dev server headlessly. Spawns the command through the platform shell
 * with `windowsHide: true` (no flashing terminal windows) and `detached: true`
 * (survives the parent), redirecting stdout+stderr to a per-project log file so
 * a dead pipe can't EPIPE-crash the parent. Fire-and-forget: the caller polls
 * the health URL to learn when it's actually up (see healthCheckDevServer).
 *
 * NEVER use `Start-Process`; NEVER kill-all-node. This is the safe primitive the
 * (formerly hard-coded) `dev-server` skill should call for ANY project.
 */
export function startDevServer(
  plan: DevServerPlan,
  cwd: string,
  options?: { logLabel?: string; env?: Record<string, string> },
  deps: StartDevServerDeps = {},
): StartDevServerResult {
  const spawnImpl = deps.spawnImpl ?? spawn;
  const openLog = deps.openLog ?? ((p: string) => openSync(p, "a"));
  const label = (options?.logLabel ?? "devserver").replace(/[^A-Za-z0-9_-]/g, "_");
  const logPath = join(tmpdir(), `kanban-${label}.log`);

  const isWindows = process.platform === "win32";
  const shell = isWindows ? "cmd.exe" : "/bin/sh";
  const shellArgs = isWindows ? ["/c", plan.command] : ["-c", plan.command];

  const fd = openLog(logPath);
  const child = spawnImpl(shell, shellArgs, {
    cwd,
    detached: true,
    windowsHide: true,
    stdio: ["ignore", fd, fd],
    env: options?.env ? { ...process.env, ...options.env } : process.env,
  });
  child.unref();

  return { pid: child.pid ?? null, logPath, command: plan.command };
}

export interface HealthCheckResult {
  ok: boolean;
  /** HTTP status when the URL answered, else null. */
  status: number | null;
  /** Total wall-clock time waited, ms. */
  waitedMs: number;
  /** Last error message when it never came up. */
  error?: string;
}

export interface HealthCheckOptions {
  /** Max attempts before giving up. Default 20. */
  attempts?: number;
  /** Delay between attempts, ms. Default 1000. */
  intervalMs?: number;
  /** Per-request timeout, ms. Default 3000. */
  requestTimeoutMs?: number;
}

export interface HealthCheckDeps {
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Poll a health URL until it answers with a non-5xx status, or attempts run out.
 * This is an in-process HTTP poll — NOT a `Get-NetTCPConnection`/`netstat` loop —
 * so it never spawns a window-flashing subprocess. A cold start binds slower than
 * any fixed sleep, so polling (not a single blind delay) is the correct wait.
 *
 * `now`-free and deterministic in tests via injectable fetch + sleep.
 */
export async function healthCheckDevServer(
  url: string,
  options: HealthCheckOptions = {},
  deps: HealthCheckDeps = {},
): Promise<HealthCheckResult> {
  const attempts = options.attempts ?? 20;
  const intervalMs = options.intervalMs ?? 1000;
  const requestTimeoutMs = options.requestTimeoutMs ?? 3000;
  const doFetch = deps.fetchImpl ?? fetch;
  const sleep = deps.sleep ?? defaultSleep;

  let lastError: string | undefined;
  let waitedMs = 0;
  for (let i = 0; i < attempts; i++) {
    if (i > 0) {
      await sleep(intervalMs);
      waitedMs += intervalMs;
    }
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), requestTimeoutMs);
      try {
        const res = await doFetch(url, { signal: controller.signal });
        // Any answer below 500 means the server is up and routing — a 404 still
        // proves it bound the port (the health path may just not exist).
        if (res.status < 500) {
          return { ok: true, status: res.status, waitedMs };
        }
        lastError = `HTTP ${res.status}`;
      } finally {
        clearTimeout(timer);
      }
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    }
  }
  return { ok: false, status: null, waitedMs, error: lastError };
}

export interface StopDevServerDeps {
  killPorts?: (ports: number[]) => Promise<number>;
}

/**
 * Stop a dev server by killing ONLY the listener on its resolved port — never all
 * node, never a range. Reuses killProcessesOnPorts, which targets exact ports and
 * still routes every kill through the board's process guard (protected PIDs spared).
 * A no-op (returns 0) when the plan has no port to target.
 */
export async function stopDevServer(
  plan: Pick<DevServerPlan, "port">,
  deps: StopDevServerDeps = {},
): Promise<number> {
  if (plan.port == null) return 0;
  const killPorts = deps.killPorts ?? killProcessesOnPorts;
  return killPorts([plan.port]);
}
