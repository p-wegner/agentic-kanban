/**
 * Per-workspace Docker Compose "service stack" engine.
 *
 * A project may declare a Compose stack (e.g. a postgres sidecar). Every workspace
 * gets its OWN isolated stack — a deterministic, UNIQUE-per-workspace, INSTANCE-scoped
 * compose project name (`ak-<instanceId8>-ws-<workspaceId12>`, see
 * `@agentic-kanban/shared/lib/service-ports`) and its own FREE host ports allocated at
 * create time — so many tickets run in parallel without port/container collisions, and
 * parallel board INSTANCES sharing one Docker daemon never reap each other's stacks.
 * The board brings the stack UP on workspace create (health-gated via `up --wait`),
 * DOWN on merge/delete/close, and reaps its own orphans on startup.
 *
 * SHARED WORKTREES (finding 12): workspaces can share ONE worktree (fork children; a
 * second workspace on the same branch — createWorktree reuses the directory). Those
 * co-residents share ONE stack: the later workspace ADOPTS the earlier one's stack
 * (same compose project recorded in its serviceState; `.kanban/services.env` is never
 * rewritten while a sharer lives), and `teardownWorkspaceServices` only downs a stack
 * when the LAST live workspace referencing it releases it (last-reference guard).
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
import { composeProjectName, isInstanceManagedComposeProject } from "@agentic-kanban/shared";
import { dockerExec, dockerAvailable } from "@agentic-kanban/shared/lib/docker-exec";
import { createStackPortAllocator, releaseStackPorts, type StackPortAllocator } from "./port-allocator.js";

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

/**
 * Make the generated `.kanban/` dir self-ignoring by dropping a `.gitignore` with `*`
 * into it (the cargo-target/npm-cache pattern; works identically in linked worktrees).
 * The env file carries allocated ports AND the project's servicesConfig secrets — an
 * un-ignored copy lands in every diff/review (getWorkingTreeDiff inlines untracked
 * content) and gets `git add -A`-committed by agents/auto-commit. Best-effort: a
 * sentinel write failure is warned loudly (secrets would leak into diffs), not fatal.
 */
async function ensureKanbanDirGitIgnored(worktreePath: string): Promise<void> {
  try {
    await writeFile(join(worktreePath, ".kanban", ".gitignore"), "*\n", { encoding: "utf-8", flag: "wx" });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") return;
    console.warn(`[services] failed to write .kanban/.gitignore sentinel (services.env may show up in diffs): ${err instanceof Error ? err.message : String(err)}`);
  }
}

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

/** Keys must be valid POSIX shell identifiers or `. services.env` breaks mid-file. */
const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * The generated file has TWO consumers with different parsers: docker's `--env-file`
 * format and the POSIX shell dot-source the ticket-context tells the agent to run
 * (`set -a; . .kanban/services.env; set +a`). Values are emitted SINGLE-QUOTED — the
 * one representation both parsers read back byte-identically (no `$` interpolation,
 * no ` #` inline-comment truncation, no word splitting) — so an entry is safe only if:
 *  - the key is a valid shell identifier (a `MY-VAR=…` line aborts the dot-source), and
 *  - the value carries no line break (would split one KEY=value into a bogus extra
 *    line, or inject an unintended var — F11) and no single quote (cannot be quoted
 *    identically for both parsers: shell needs `'\''`, compose ends the value there).
 * Unsafe entries are DROPPED with a loud warning, never emitted divergently (F12).
 */
function isEnvLineSafe(key: string, value: string): boolean {
  if (!ENV_KEY_RE.test(key)) {
    console.warn(`[services] dropping env entry whose key is not a valid identifier: ${JSON.stringify(key)}`);
    return false;
  }
  if (/[\r\n]/.test(value)) {
    console.warn(`[services] dropping env entry with a line break in its value: ${JSON.stringify(key)}`);
    return false;
  }
  if (value.includes("'")) {
    console.warn(`[services] dropping env entry with a single quote in its value (cannot be represented identically for compose --env-file AND shell sourcing): ${JSON.stringify(key)}`);
    return false;
  }
  return true;
}

/**
 * One `KEY='value'` line. Single quotes are literal for BOTH docker's env-file parser
 * and POSIX shell sourcing, so the containers and the agent see the same bytes (F12).
 */
function envLine(key: string, value: string): string {
  return `${key}='${value}'`;
}

/** Serialize the generated env file body (compose --env-file AND shell-sourceable). */
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
    envLine("COMPOSE_PROJECT_NAME", args.composeProjectName),
    envLine("KANBAN_STACK", "1"),
  ];
  if (isEnvLineSafe("KANBAN_SERVICE_HOST", serviceHost)) {
    lines.push(envLine("KANBAN_SERVICE_HOST", serviceHost));
  }
  for (const [name, port] of Object.entries(args.ports)) {
    lines.push(envLine(portEnvVar(name), String(port)));
  }
  for (const [key, value] of Object.entries(args.config.env ?? {})) {
    if (isEnvLineSafe(key, value)) lines.push(envLine(key, value));
  }
  for (const [key, value] of Object.entries(args.extraEnv ?? {})) {
    if (isEnvLineSafe(key, value)) lines.push(envLine(key, value));
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

/**
 * Parse a persisted ServiceStackState JSON blob into a typed state, or null when it is
 * absent/unparseable/structurally invalid. Used by the shared-worktree ADOPTION path
 * (a second workspace on a reused worktree records its co-resident's stack instead of
 * provisioning a second one), which needs the FULL state (name, ports, env file), not
 * just the compose name.
 */
export function parseStoredServiceStackState(serviceStateJson: string | null | undefined): ServiceStackState | null {
  if (!serviceStateJson) return null;
  try {
    const parsed = JSON.parse(serviceStateJson) as Partial<ServiceStackState> | null;
    if (!parsed || typeof parsed !== "object") return null;
    if (typeof parsed.composeProjectName !== "string") return null;
    if (parsed.status !== "up" && parsed.status !== "error" && parsed.status !== "down") return null;
    return {
      composeProjectName: parsed.composeProjectName,
      ports: parsed.ports && typeof parsed.ports === "object" ? (parsed.ports as Record<string, number>) : {},
      envFilePath: typeof parsed.envFilePath === "string" ? parsed.envFilePath : "",
      status: parsed.status,
      ...(typeof parsed.error === "string" ? { error: parsed.error } : {}),
      updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : new Date().toISOString(),
    };
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
  allocatePorts?: StackPortAllocator;
  /**
   * This server instance's persisted id (scopes compose names, see service-ports.ts).
   * Injected for testability; the default lazily reads/creates it in the DB — lazy so
   * unit tests that inject a fake never touch the repository/DB module at load.
   */
  getInstanceId?: () => Promise<string>;
  /** Persist "stack is down" onto the owning workspace row after a successful down. */
  markServiceStateDown?: (composeProjectName: string) => Promise<void>;
  /**
   * Live workspaces whose persisted state still claims a compose project as "up" —
   * the teardown last-reference guard (shared worktrees, finding 12). Injected for
   * testability; the default lazily reads the repository.
   */
  findLiveStackReferences?: (composeProjectName: string) => Promise<{ id: string }[]>;
} = {}) {
  const runner = deps.runner ?? createDefaultComposeRunner();
  // Default allocator: draws from KANBAN_STACK_PORT_RANGE (or ephemeral when unset) and
  // excludes ports held by this board's live stacks (queried from the DB) so a restart —
  // which empties the in-process reservation registry — never re-hands a live port (#51).
  const allocatePorts =
    deps.allocatePorts ??
    createStackPortAllocator({
      getInUsePorts: async () => {
        const { getLiveStackHostPorts } = await import("../repositories/workspace-service-state.repository.js");
        return getLiveStackHostPorts();
      },
    });
  const getInstanceId =
    deps.getInstanceId ??
    (async () => {
      const { getOrCreateServiceStackInstanceId } = await import("../repositories/workspace-service-state.repository.js");
      return getOrCreateServiceStackInstanceId();
    });
  const markServiceStateDown =
    deps.markServiceStateDown ??
    (async (name: string) => {
      const { markWorkspaceServiceStateDown } = await import("../repositories/workspace-service-state.repository.js");
      await markWorkspaceServiceStateDown(name);
    });
  const findLiveStackReferences =
    deps.findLiveStackReferences ??
    (async (name: string) => {
      const { findLiveWorkspacesReferencingComposeProject } = await import("../repositories/workspace-service-state.repository.js");
      return findLiveWorkspacesReferencingComposeProject(name);
    });

  /**
   * Bring a workspace's declared stack up. Allocates free host ports, writes the
   * generated env file, and runs `docker compose … up -d --wait`. Returns a
   * ServiceStackState in EVERY case (status "up" on success, "error" with the compose
   * stderr on failure) — the caller persists it and never rolls back the worktree.
   */
  async function provisionWorkspaceServices(args: ProvisionServicesArgs): Promise<ServiceStackState> {
    const { config, workspaceId, composeWorktreePath, extraEnv } = args;
    const envFilePath = join(composeWorktreePath, ENV_FILE_REL);
    const composeFile = config.composeFile || "docker-compose.yml";
    const timeoutMs = config.readyTimeoutMs ?? 120000;
    const portNames = (config.ports ?? []).filter((n) => n.trim().length > 0);

    // The compose name is scoped to this instance's persisted id (see service-ports.ts)
    // so parallel board instances sharing the daemon never claim each other's stacks.
    let name: string;
    try {
      name = composeProjectName(workspaceId, await getInstanceId());
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { composeProjectName: "", ports: {}, envFilePath, status: "error", error: `failed to resolve the service-stack instance id: ${message}`.slice(0, MAX_ERROR_CHARS), updatedAt: new Date().toISOString() };
    }

    // Allocate host ports (if any) and (re)write the env file. Broken out so the
    // port-collision retry below can re-run it with a fresh set of ports. Each call
    // RELEASES the previous set's reservation before allocating again, so a retry never
    // leaks the abandoned ports out of the range.
    let ports: Record<string, number> = {};
    async function allocateAndWriteEnv(): Promise<void> {
      releaseStackPorts(Object.values(ports));
      ports = portNames.length > 0 ? await allocatePorts(portNames) : {};
      await mkdir(join(composeWorktreePath, ".kanban"), { recursive: true });
      await ensureKanbanDirGitIgnored(composeWorktreePath);
      await writeFile(
        envFilePath,
        buildServicesEnvFile({ composeProjectName: name, ports, config, extraEnv }),
        "utf-8",
      );
    }

    // The allocator holds each returned port in its in-process reservation registry so a
    // concurrent provision can't be handed the same number in the allocate→`up` window
    // (#51 flaw 2). Release on EVERY exit: on success the daemon now holds the real
    // binding (and the caller persists the ports, which `getInUsePorts` then excludes);
    // on failure the port was never bound. Keeping it reserved past here would leak the
    // range across the server's lifetime.
    try {
      try {
        await allocateAndWriteEnv();
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { composeProjectName: name, ports, envFilePath, status: "error", error: message.slice(0, MAX_ERROR_CHARS), updatedAt: new Date().toISOString() };
      }

      // `up -d --wait` with a bounded port-collision retry. A parallel create or the
      // host/dind namespace can still steal a port → "port is already allocated"; on that
      // specific failure we reallocate (drawing a fresh unused number from the range),
      // rewrite the env file, and retry (PORT-RETRY). Any partial containers from the
      // failed attempt are cleared with a best-effort down first.
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
    } finally {
      releaseStackPorts(Object.values(ports));
    }
  }

  /**
   * Tear a workspace's stack down (`docker compose -p <name> down -v --remove-orphans`).
   * Best-effort and never throws — teardown runs on merge/delete/close paths that must
   * not be blocked by a docker hiccup. Takes the STORED compose project name (from the
   * persisted ServiceStackState) — NEVER a recomputed one — so it can never target the
   * wrong (or a sibling workspace's) stack (F1).
   *
   * LAST-REFERENCE GUARD (shared worktrees, finding 12): co-resident workspaces
   * (worktree reuse / fork children) ADOPT one shared stack — several live rows can
   * reference the same compose project. The down only runs when the RELEASING
   * workspace is the last live referent; otherwise it is skipped (and the state stays
   * "up", because the stack IS up). `releasedByWorkspaceId` is REQUIRED and is the only
   * way the releaser is identified — an earlier fallback inferred it from the compose
   * name's owner token, which inverted the guard exactly for the adoption case it was
   * meant to protect (an adopter merging would `down -v` the live owner's stack and its
   * volumes). Mirrors the findLiveSiblingSharers guard for sibling worktrees — on a
   * failed sharer check the down is skipped too (a leaked stack beats downing a live
   * shared one; the startup reaper reclaims true orphans).
   */
  async function teardownWorkspaceServices(args: {
    composeProjectName: string;
    composeWorktreePath: string;
    /** The workspace releasing the stack (excluded from the live-sharer count). */
    releasedByWorkspaceId: string;
  }): Promise<void> {
    try {
      const refs = await findLiveStackReferences(args.composeProjectName);
      const otherSharers = refs.filter((r) => r.id !== args.releasedByWorkspaceId);
      if (otherSharers.length > 0) {
        console.log(
          `[services] stack ${args.composeProjectName} is still referenced by ${otherSharers.length} other live workspace(s) (${otherSharers.map((r) => r.id).join(", ")}) — skipping the down (last sharer releases it)`,
        );
        return;
      }
    } catch (err) {
      console.warn(
        `[services] teardown sharer check failed for ${args.composeProjectName} — skipping the down to be safe (the startup reaper reclaims true orphans): ${err instanceof Error ? err.message : String(err)}`,
      );
      return;
    }
    try {
      const { ok, stderr } = await runner.down({ projectName: args.composeProjectName, cwd: args.composeWorktreePath });
      // dockerExec never throws, so a failed down surfaces only here as ok:false (F6).
      if (!ok && stderr) {
        console.warn(`[services] teardown down for ${args.composeProjectName} reported failure (non-fatal): ${stderr}`);
      }
      // Persist status "down" onto the owning row so the workspace DTO stops reporting
      // a downed stack as up (with ports that may get reassigned). Only after a
      // SUCCESSFUL down — a failed down may have left containers running.
      if (ok) {
        await markServiceStateDown(args.composeProjectName);
      }
    } catch (err) {
      console.warn(`[services] teardown failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * Reap stacks THIS INSTANCE owns (`isInstanceManagedComposeProject`, i.e. names
   * carrying this instance's persisted id) that no open workspace expects — orphans
   * left by a crash/hard-restart. `knownComposeProjectNames` is the set of names every
   * currently-open workspace maps to; anything instance-managed and NOT in it gets
   * downed. Names of OTHER instances sharing the daemon (`ak-<otherId>-ws-…`) and
   * legacy unscoped names (`ak-ws-…`, pre-instance-id stacks whose owner is unknowable)
   * are NEVER touched. Best-effort per stack.
   */
  async function reapOrphanServiceStacks(args: {
    knownComposeProjectNames: Set<string>;
  }): Promise<{ reaped: string[] }> {
    const reaped: string[] = [];
    let instanceId: string;
    try {
      instanceId = await getInstanceId();
    } catch (err) {
      // Without a proven identity we must not down ANYTHING on the shared daemon.
      console.warn(`[services] reaper skipped — could not resolve this instance's id: ${err instanceof Error ? err.message : String(err)}`);
      return { reaped };
    }
    let names: string[] = [];
    try {
      names = await runner.list();
    } catch (err) {
      console.warn(`[services] reaper list failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
      return { reaped };
    }
    for (const name of names) {
      if (!isInstanceManagedComposeProject(name, instanceId)) continue;
      if (args.knownComposeProjectNames.has(name)) continue;
      try {
        await runner.down({ projectName: name, cwd: process.cwd() });
        // A matching row can only be a terminal (closed) workspace's stale blob; mark
        // it down so it stops reporting a reaped stack as up. Best-effort.
        await markServiceStateDown(name).catch(() => {});
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
