/**
 * Per-workspace Docker Compose "service stack" engine.
 *
 * A project may declare a Compose stack (e.g. a postgres sidecar). Every workspace
 * gets its OWN isolated stack — a deterministic, UNIQUE-per-workspace compose project
 * name (`ak-ws-<workspaceId12>`, see `@agentic-kanban/shared/lib/service-ports`) and
 * its own FREE host ports allocated at create time — so many tickets run in parallel
 * without port/container collisions. The board brings the stack UP on workspace create
 * (health-gated via `up --wait`), DOWN on merge/delete/close, and reaps orphans on
 * startup.
 *
 * Everything here degrades gracefully when docker is absent: the default runner guards
 * every invocation with `dockerAvailable()`, so the single-user local (no-docker)
 * workflow — where `servicesConfig` is disabled — is completely unaffected.
 *
 * The compose CLI is spawned ONLY through the sanctioned docker-exec adapter
 * (`@agentic-kanban/shared/lib/docker-exec`, a never-throwing port). `runCompose` is
 * injected so the engine is unit-testable with a fake runner (no docker required).
 */

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ServiceStackConfig, ServiceStackState } from "@agentic-kanban/shared";
import { composeProjectName, isManagedComposeProject } from "@agentic-kanban/shared";
import { dockerExec, dockerAvailable } from "@agentic-kanban/shared/lib/docker-exec";
import { allocateFreePorts } from "./port-allocator.js";

/** Max chars of compose stderr preserved on an error state (keep DB rows bounded). */
const MAX_ERROR_CHARS = 2000;

/**
 * The compose driver, injected for testability. The default implementation shells out
 * to `docker compose` via the docker-exec adapter; tests pass a fake.
 */
export interface ComposeRunner {
  up(args: {
    composeFile: string;
    cwd: string;
    projectName: string;
    envFile: string;
    timeoutMs: number;
    env?: NodeJS.ProcessEnv;
  }): Promise<{ ok: boolean; stderr: string }>;
  down(args: { projectName: string; cwd: string; env?: NodeJS.ProcessEnv }): Promise<{ ok: boolean; stderr: string }>;
  /** Compose project names currently known to the daemon (running or stopped). */
  list(env?: NodeJS.ProcessEnv): Promise<string[]>;
}

/** Arguments for provisioning a workspace's stack. */
export interface ProvisionServicesArgs {
  config: ServiceStackConfig;
  /** The workspace's UNIQUE id — the compose project name is keyed on this (F1). */
  workspaceId: string;
  /** Worktree that holds the compose file (leading worktree, or the composeRepo sibling). */
  composeWorktreePath: string;
  /** Extra env vars written verbatim into the generated env file (e.g. workspace/branch). */
  extraEnv?: Record<string, string>;
}

/** Relative location (from a worktree root) of the generated compose env file. */
const ENV_FILE_REL = join(".kanban", "services.env");

/** Uppercase + sanitize a port name into an env-var-safe token: KANBAN_SVC_<NAME>_PORT. */
function portEnvVar(name: string): string {
  return `KANBAN_SVC_${name.toUpperCase().replace(/[^A-Z0-9]/g, "_")}_PORT`;
}

/**
 * Host the agent should reach the stack's services on. Defaults to `localhost` (the
 * single-user, board-on-host case). When the board itself runs in a container the DB
 * lives elsewhere: DooD → `host.docker.internal`; DinD → the `dind` sidecar service
 * name. The deployment sets `KANBAN_SERVICE_HOST` accordingly. (F2)
 */
export function resolveServiceHost(env: NodeJS.ProcessEnv = process.env): string {
  const v = env.KANBAN_SERVICE_HOST?.trim();
  return v && v.length > 0 ? v : "localhost";
}

/**
 * An env value is safe to emit into the `--env-file` only if it carries no line breaks —
 * a CR/LF would split one KEY=value into a bogus extra line (or inject an unintended var).
 * The project route validates env on write, but the WRITER must not emit a broken file
 * regardless of how the value arrived here (F11).
 */
function isEnvLineSafe(key: string, value: string): boolean {
  if (/[\r\n]/.test(key) || /[\r\n]/.test(value)) {
    console.warn(`[services] dropping env entry with a line break in key/value: ${JSON.stringify(key)}`);
    return false;
  }
  return true;
}

/** Serialize the generated env file body (KEY=value lines, docker --env-file format). */
export function buildServicesEnvFile(args: {
  composeProjectName: string;
  ports: Record<string, number>;
  config: ServiceStackConfig;
  extraEnv?: Record<string, string>;
  /** Host the agent reaches services on; defaults to resolveServiceHost(). */
  serviceHost?: string;
}): string {
  const serviceHost = args.serviceHost ?? resolveServiceHost();
  const lines: string[] = [
    `COMPOSE_PROJECT_NAME=${args.composeProjectName}`,
    "KANBAN_STACK=1",
  ];
  if (isEnvLineSafe("KANBAN_SERVICE_HOST", serviceHost)) {
    lines.push(`KANBAN_SERVICE_HOST=${serviceHost}`);
  }
  for (const [name, port] of Object.entries(args.ports)) {
    lines.push(`${portEnvVar(name)}=${port}`);
  }
  for (const [key, value] of Object.entries(args.config.env ?? {})) {
    if (isEnvLineSafe(key, value)) lines.push(`${key}=${value}`);
  }
  for (const [key, value] of Object.entries(args.extraEnv ?? {})) {
    if (isEnvLineSafe(key, value)) lines.push(`${key}=${value}`);
  }
  return lines.join("\n") + "\n";
}

/**
 * Extract the stored compose project name from a persisted ServiceStackState JSON blob
 * (`workspaces.service_state`). Teardown + the reaper MUST use this stored name, never a
 * recomputed one, so the name can never drift from what provisioning actually created
 * (F1). Returns null when there is no state or it can't be parsed.
 */
export function parseStoredComposeProjectName(serviceStateJson: string | null | undefined): string | null {
  if (!serviceStateJson) return null;
  try {
    const parsed = JSON.parse(serviceStateJson) as { composeProjectName?: unknown };
    return typeof parsed.composeProjectName === "string" && parsed.composeProjectName.length > 0
      ? parsed.composeProjectName
      : null;
  } catch {
    return null;
  }
}

/** Heuristic: does a compose `up` stderr indicate a host/namespace port collision? */
function isPortInUseError(stderr: string): boolean {
  return /port is already allocated|address already in use|bind for .* failed|ports are not available|failed to bind|Only one usage of each socket address/i.test(stderr);
}

/**
 * Default compose driver: shells out to `docker compose` through the docker-exec
 * adapter. Every method first checks `dockerAvailable()` so a host without docker
 * no-ops cleanly (up → ok:false with a clear message; list → []).
 */
export function createDefaultComposeRunner(): ComposeRunner {
  return {
    async up({ composeFile, cwd, projectName, envFile, timeoutMs, env }) {
      if (!(await dockerAvailable(env))) {
        return { ok: false, stderr: "docker is not available on this host (service stack skipped)" };
      }
      const res = await dockerExec(
        ["compose", "-p", projectName, "-f", composeFile, "--env-file", envFile, "up", "-d", "--wait"],
        { cwd, env, timeoutMs },
      );
      return { ok: res.code === 0, stderr: res.stderr || res.error || "" };
    },
    async down({ projectName, cwd, env }) {
      if (!(await dockerAvailable(env))) {
        return { ok: false, stderr: "docker is not available on this host" };
      }
      const res = await dockerExec(["compose", "-p", projectName, "down", "-v", "--remove-orphans"], { cwd, env });
      return { ok: res.code === 0, stderr: res.stderr || res.error || "" };
    },
    async list(env) {
      if (!(await dockerAvailable(env))) return [];
      const res = await dockerExec(["compose", "ls", "--all", "--format", "json"], { env });
      if (res.code !== 0) return [];
      try {
        const parsed: unknown = JSON.parse(res.stdout || "[]");
        if (!Array.isArray(parsed)) return [];
        return parsed
          .map((entry) => (entry && typeof entry === "object" ? (entry as { Name?: unknown }).Name : undefined))
          .filter((name): name is string => typeof name === "string" && name.length > 0);
      } catch {
        return [];
      }
    },
  };
}

export function createWorkspaceServicesService(deps: {
  runner?: ComposeRunner;
  allocatePorts?: typeof allocateFreePorts;
} = {}) {
  const runner = deps.runner ?? createDefaultComposeRunner();
  const allocatePorts = deps.allocatePorts ?? allocateFreePorts;

  /**
   * Bring a workspace's declared stack up. Allocates free host ports, writes the
   * generated env file, and runs `docker compose … up -d --wait`. Returns a
   * ServiceStackState in EVERY case (status "up" on success, "error" with the compose
   * stderr on failure) — the caller persists it and never rolls back the worktree.
   */
  async function provisionWorkspaceServices(args: ProvisionServicesArgs): Promise<ServiceStackState> {
    const { config, workspaceId, composeWorktreePath, extraEnv } = args;
    const name = composeProjectName(workspaceId);
    const envFilePath = join(composeWorktreePath, ENV_FILE_REL);
    const composeFile = config.composeFile || "docker-compose.yml";
    const timeoutMs = config.readyTimeoutMs ?? 120000;
    const portNames = (config.ports ?? []).filter((n) => n.trim().length > 0);

    // Allocate free host ports (if any) and (re)write the env file. Broken out so the
    // port-collision retry below can re-run it with a fresh set of ports.
    let ports: Record<string, number> = {};
    async function allocateAndWriteEnv(): Promise<void> {
      ports = portNames.length > 0 ? await allocatePorts(portNames) : {};
      await mkdir(join(composeWorktreePath, ".kanban"), { recursive: true });
      await writeFile(
        envFilePath,
        buildServicesEnvFile({ composeProjectName: name, ports, config, extraEnv }),
        "utf-8",
      );
    }

    try {
      await allocateAndWriteEnv();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { composeProjectName: name, ports, envFilePath, status: "error", error: message.slice(0, MAX_ERROR_CHARS), updatedAt: new Date().toISOString() };
    }

    // `up -d --wait` with a bounded port-collision retry. allocateFreePorts frees the
    // reserved ports before compose binds them, so a parallel create or the host/dind
    // namespace can steal one → "port is already allocated". On that specific failure we
    // reallocate, rewrite the env file, and retry (PORT-RETRY). Any partial containers
    // from the failed attempt are cleared with a best-effort down first.
    const MAX_UP_ATTEMPTS = 3; // initial + 2 retries
    let lastStderr = "";
    for (let attempt = 1; attempt <= MAX_UP_ATTEMPTS; attempt++) {
      const { ok, stderr } = await runner.up({ composeFile, cwd: composeWorktreePath, projectName: name, envFile: envFilePath, timeoutMs });
      if (ok) {
        return { composeProjectName: name, ports, envFilePath, status: "up", updatedAt: new Date().toISOString() };
      }
      lastStderr = stderr;
      const canRetry = attempt < MAX_UP_ATTEMPTS && portNames.length > 0 && isPortInUseError(stderr);
      if (!canRetry) break;
      console.warn(`[services] compose up for ${name} hit a port collision (attempt ${attempt}/${MAX_UP_ATTEMPTS}); reallocating ports and retrying`);
      // Clear anything the failed attempt may have started before rebinding new ports.
      await runner.down({ projectName: name, cwd: composeWorktreePath }).catch(() => {});
      try {
        await allocateAndWriteEnv();
      } catch (err) {
        lastStderr = err instanceof Error ? err.message : String(err);
        break;
      }
    }

    // F5(a): `up --wait` can start some containers then fail the health gate, leaving
    // them running. Run a best-effort compensating down so no partial stack lingers
    // before we return the error state.
    await runner.down({ projectName: name, cwd: composeWorktreePath }).catch(() => {});

    return { composeProjectName: name, ports, envFilePath, status: "error", error: (lastStderr || "compose up failed").slice(0, MAX_ERROR_CHARS), updatedAt: new Date().toISOString() };
  }

  /**
   * Tear a workspace's stack down (`docker compose -p <name> down -v --remove-orphans`).
   * Best-effort and never throws — teardown runs on merge/delete/close paths that must
   * not be blocked by a docker hiccup. Takes the STORED compose project name (from the
   * persisted ServiceStackState) — NEVER a recomputed one — so it can never target the
   * wrong (or a sibling workspace's) stack (F1).
   */
  async function teardownWorkspaceServices(args: {
    composeProjectName: string;
    composeWorktreePath: string;
  }): Promise<void> {
    try {
      const { ok, stderr } = await runner.down({ projectName: args.composeProjectName, cwd: args.composeWorktreePath });
      // dockerExec never throws, so a failed down surfaces only here as ok:false (F6).
      if (!ok && stderr) {
        console.warn(`[services] teardown down for ${args.composeProjectName} reported failure (non-fatal): ${stderr}`);
      }
    } catch (err) {
      console.warn(`[services] teardown failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * Reap stacks the board owns (`isManagedComposeProject`) that no open workspace
   * expects — orphans left by a crash/hard-restart. `knownComposeProjectNames` is the
   * set of names every currently-open workspace maps to; anything managed and NOT in it
   * gets downed. Best-effort per stack.
   */
  async function reapOrphanServiceStacks(args: {
    knownComposeProjectNames: Set<string>;
  }): Promise<{ reaped: string[] }> {
    const reaped: string[] = [];
    let names: string[] = [];
    try {
      names = await runner.list();
    } catch (err) {
      console.warn(`[services] reaper list failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
      return { reaped };
    }
    for (const name of names) {
      if (!isManagedComposeProject(name)) continue;
      if (args.knownComposeProjectNames.has(name)) continue;
      try {
        await runner.down({ projectName: name, cwd: process.cwd() });
        reaped.push(name);
      } catch (err) {
        console.warn(`[services] reaper down failed for ${name} (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    return { reaped };
  }

  return { provisionWorkspaceServices, teardownWorkspaceServices, reapOrphanServiceStacks };
}

/**
 * Process-wide default instance (real docker driver), used by the create/teardown/
 * reaper wiring. Tests construct their own with a fake runner.
 */
export const workspaceServicesService = createWorkspaceServicesService();
