/**
 * Per-workspace Docker Compose "service stack" engine.
 *
 * A project may declare a Compose stack (e.g. a postgres sidecar). Every workspace
 * gets its OWN isolated stack — a deterministic, project-scoped compose project name
 * (`ak-<projectId8>-ws-<offset>`, see `@agentic-kanban/shared/lib/service-ports`) and
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
  projectId: string;
  offset: number;
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

/** Serialize the generated env file body (KEY=value lines, docker --env-file format). */
export function buildServicesEnvFile(args: {
  composeProjectName: string;
  ports: Record<string, number>;
  config: ServiceStackConfig;
  extraEnv?: Record<string, string>;
}): string {
  const lines: string[] = [
    `COMPOSE_PROJECT_NAME=${args.composeProjectName}`,
    "KANBAN_STACK=1",
  ];
  for (const [name, port] of Object.entries(args.ports)) {
    lines.push(`${portEnvVar(name)}=${port}`);
  }
  for (const [key, value] of Object.entries(args.config.env ?? {})) {
    lines.push(`${key}=${value}`);
  }
  for (const [key, value] of Object.entries(args.extraEnv ?? {})) {
    lines.push(`${key}=${value}`);
  }
  return lines.join("\n") + "\n";
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
    const { config, projectId, offset, composeWorktreePath, extraEnv } = args;
    const name = composeProjectName(projectId, offset);
    const envFilePath = join(composeWorktreePath, ENV_FILE_REL);
    const updatedAt = new Date().toISOString();

    let ports: Record<string, number> = {};
    try {
      const portNames = (config.ports ?? []).filter((n) => n.trim().length > 0);
      if (portNames.length > 0) {
        ports = await allocatePorts(portNames);
      }

      await mkdir(join(composeWorktreePath, ".kanban"), { recursive: true });
      await writeFile(
        envFilePath,
        buildServicesEnvFile({ composeProjectName: name, ports, config, extraEnv }),
        "utf-8",
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { composeProjectName: name, ports, envFilePath, status: "error", error: message.slice(0, MAX_ERROR_CHARS), updatedAt };
    }

    const { ok, stderr } = await runner.up({
      composeFile: config.composeFile || "docker-compose.yml",
      cwd: composeWorktreePath,
      projectName: name,
      envFile: envFilePath,
      timeoutMs: config.readyTimeoutMs ?? 120000,
    });

    return ok
      ? { composeProjectName: name, ports, envFilePath, status: "up", updatedAt: new Date().toISOString() }
      : { composeProjectName: name, ports, envFilePath, status: "error", error: (stderr || "compose up failed").slice(0, MAX_ERROR_CHARS), updatedAt: new Date().toISOString() };
  }

  /**
   * Tear a workspace's stack down (`docker compose -p <name> down -v --remove-orphans`).
   * Best-effort and never throws — teardown runs on merge/delete/close paths that must
   * not be blocked by a docker hiccup. Teardown needs only the DETERMINISTIC compose
   * project name, never the allocated ports.
   */
  async function teardownWorkspaceServices(args: {
    projectId: string;
    offset: number;
    composeWorktreePath: string;
  }): Promise<void> {
    try {
      const name = composeProjectName(args.projectId, args.offset);
      await runner.down({ projectName: name, cwd: args.composeWorktreePath });
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
