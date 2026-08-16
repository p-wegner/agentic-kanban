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

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ServiceStackConfig, ServiceStackState } from "@agentic-kanban/shared";
import { composeProjectName, isInstanceManagedComposeProject } from "@agentic-kanban/shared";
import { dockerExec, dockerAvailable } from "@agentic-kanban/shared/lib/docker-exec";
import { createStackPortAllocator, releaseStackPorts, type StackPortAllocator } from "./port-allocator.js";
import {
  ensureKanbanDirGitIgnored,
  discoverComposePortNames,
  lintSiblingComposeFiles,
  buildServicesEnvFile,
  resolveServiceHost,
} from "./workspace-services-env.js";
import { errorMessage } from "@agentic-kanban/shared/lib/error-message";

export { resolveServiceHost, buildServicesEnvFile } from "./workspace-services-env.js";

/**
 * Shared invocation context for the user-initiated lifecycle controls (#92) over an
 * ALREADY-provisioned stack. The stored state's `composeProjectName`, `ports` and
 * `envFilePath` are reused VERBATIM — no port is reallocated — so a stop→start or a
 * restart keeps the workspace on the host ports the agent was told about.
 *
 * Exported at module scope so the exported factory's inferred return type does not
 * leak a private name (TS4060/TS4025); hoisted from inside the factory in a
 * post-merge fix (#92).
 */
export interface StackControlContext {
  state: ServiceStackState;
  config: ServiceStackConfig;
  composeWorktreePath: string;
  workspaceId: string;
}

/** Max chars of compose stderr preserved on an error state (keep DB rows bounded). */
const MAX_ERROR_CHARS = 2000;

/** The label compose stamps on every resource (container, volume, network, image) it
 *  creates, carrying the compose project name — the join key for label-based inventory
 *  of container-less residue (#163). */
const COMPOSE_PROJECT_LABEL = "com.docker.compose.project";

/**
 * The compose driver, injected for testability. The default implementation shells out
 * to `docker compose` via the docker-exec adapter; tests pass a fake.
 */
export interface ComposeRunner {
  up(args: {
    composeFile: string;
    /** Additional compose files (absolute paths) merged in via extra `-f` flags — one per
     *  registered repo that ships its own docker-compose.yml (#71). Same compose project,
     *  same env file, torn down together with the primary stack. */
    extraComposeFiles?: string[];
    cwd: string;
    projectName: string;
    envFile: string;
    timeoutMs: number;
    env?: NodeJS.ProcessEnv;
    /** Add `--force-recreate` so existing containers are recreated (the "rebuild" control, #92). */
    forceRecreate?: boolean;
  }): Promise<{ ok: boolean; stderr: string }>;
  down(args: {
    projectName: string;
    cwd: string;
    env?: NodeJS.ProcessEnv;
    /**
     * Remove named volumes too (`-v`). Defaults to true — the teardown/reaper paths pass
     * nothing and keep the original destructive down. The user-initiated STOP control (#92)
     * passes `false` so a subsequent START finds its data intact.
     */
    removeVolumes?: boolean;
  }): Promise<{ ok: boolean; stderr: string }>;
  /** `docker compose restart` — bounce the running containers, reusing the same ports (#92). */
  restart(args: {
    composeFile: string;
    extraComposeFiles?: string[];
    projectName: string;
    cwd: string;
    envFile: string;
    env?: NodeJS.ProcessEnv;
    timeoutMs?: number;
  }): Promise<{ ok: boolean; stderr: string }>;
  /** `docker compose logs --tail N` — a BOUNDED, non-following tail (never hangs, #92). */
  logs(args: {
    composeFile: string;
    extraComposeFiles?: string[];
    projectName: string;
    cwd: string;
    envFile: string;
    tail: number;
    env?: NodeJS.ProcessEnv;
    timeoutMs?: number;
  }): Promise<{ ok: boolean; stdout: string; stderr: string }>;
  /** Compose project names currently known to the daemon (running or stopped). */
  list(env?: NodeJS.ProcessEnv): Promise<string[]>;
  /**
   * Compose project names carried by LABELED volumes/networks/images on the daemon —
   * container-less residue `list()` (container-derived `compose ls`) can never see: a
   * failed compensating down that removed containers but errored on the volume, or
   * containers pruned externally, leaves named volumes/networks/`--rmi local` images
   * behind with no container left to report the project (#163).
   */
  listResidualProjects(env?: NodeJS.ProcessEnv): Promise<string[]>;
  /**
   * Remove every volume/network/image labeled `com.docker.compose.project=<projectName>`
   * directly (not via `compose down -p`, which resolves the project from CONTAINER
   * labels — a project with no containers left cannot be downed by name at all, #163).
   */
  removeResidualProjectResources(projectName: string, env?: NodeJS.ProcessEnv): Promise<{ ok: boolean; stderr: string }>;
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
      ...(parsed.deferred === true ? { deferred: true } : {}),
      ...(Array.isArray(parsed.lintWarnings) && parsed.lintWarnings.every((w) => typeof w === "string")
        ? { lintWarnings: parsed.lintWarnings as string[] }
        : {}),
      updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : new Date().toISOString(),
    };
  } catch {
    return null;
  }
}

/**
 * Thrown by the user-initiated Stop/Restart controls (#92) when the last-reference
 * guard (finding 12) finds another LIVE workspace still referencing the same compose
 * project — the adopted-stack case (shared worktree) where downing/bouncing the
 * containers would pull them out from under that other workspace's running agent.
 * The sharer check having FAILED (can't prove it's safe) also throws this, with an
 * empty `otherSharers` — refuse rather than silently risk a live shared stack.
 */
export class StackSharedInUseError extends Error {
  constructor(
    public readonly composeProjectName: string,
    public readonly otherSharers: string[],
  ) {
    super(
      otherSharers.length > 0
        ? `stack ${composeProjectName} is still referenced by ${otherSharers.length} other live workspace(s) (${otherSharers.join(", ")})`
        : `could not verify stack ${composeProjectName} has no other live sharers — refusing to be safe`,
    );
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
    async up({ composeFile, extraComposeFiles, cwd, projectName, envFile, timeoutMs, env, forceRecreate }) {
      if (!(await dockerAvailable(env))) {
        return { ok: false, stderr: "docker is not available on this host (service stack skipped)" };
      }
      const fileArgs = ["-f", composeFile, ...(extraComposeFiles ?? []).flatMap((f) => ["-f", f])];
      const upFlags = forceRecreate ? ["up", "-d", "--wait", "--force-recreate"] : ["up", "-d", "--wait"];
      const res = await dockerExec(
        ["compose", "-p", projectName, ...fileArgs, "--env-file", envFile, ...upFlags],
        { cwd, env, timeoutMs },
      );
      return { ok: res.code === 0, stderr: res.stderr || res.error || "" };
    },
    async down({ projectName, cwd, env, removeVolumes }) {
      if (!(await dockerAvailable(env))) {
        return { ok: false, stderr: "docker is not available on this host" };
      }
      // Full teardown adds `--rmi local`: compose removes images it built itself
      // (a `build:`-context service with no `image:` field, auto-tagged
      // `<projectName>-<service>`) while leaving pull-based images (postgres, redis,
      // …, referenced by their custom `image:` name) untouched. Without it, every
      // workspace that provisions a build-context stack leaks a uniquely-named image
      // forever, since each workspace's compose project name is distinct (#106). The
      // volume-preserving stop path (removeVolumes === false) keeps the image so a
      // later restart is fast.
      const downFlags =
        removeVolumes === false
          ? ["down", "--remove-orphans"]
          : ["down", "-v", "--rmi", "local", "--remove-orphans"];
      const res = await dockerExec(["compose", "-p", projectName, ...downFlags], { cwd, env });
      return { ok: res.code === 0, stderr: res.stderr || res.error || "" };
    },
    async restart({ composeFile, extraComposeFiles, projectName, cwd, envFile, env, timeoutMs }) {
      if (!(await dockerAvailable(env))) {
        return { ok: false, stderr: "docker is not available on this host" };
      }
      const fileArgs = ["-f", composeFile, ...(extraComposeFiles ?? []).flatMap((f) => ["-f", f])];
      const res = await dockerExec(
        ["compose", "-p", projectName, ...fileArgs, "--env-file", envFile, "restart"],
        { cwd, env, timeoutMs: timeoutMs ?? 120000 },
      );
      return { ok: res.code === 0, stderr: res.stderr || res.error || "" };
    },
    async logs({ composeFile, extraComposeFiles, projectName, cwd, envFile, tail, env, timeoutMs }) {
      if (!(await dockerAvailable(env))) {
        return { ok: false, stdout: "", stderr: "docker is not available on this host" };
      }
      const safeTail = Number.isFinite(tail) && tail > 0 ? Math.floor(tail) : 200;
      const fileArgs = ["-f", composeFile, ...(extraComposeFiles ?? []).flatMap((f) => ["-f", f])];
      // No `-f`/`--follow`: a bounded `--tail` returns immediately instead of streaming
      // forever (the acceptance criterion "returns a recent tail without hanging", #92).
      const res = await dockerExec(
        ["compose", "-p", projectName, ...fileArgs, "--env-file", envFile, "logs", "--no-color", "--tail", String(safeTail)],
        { cwd, env, timeoutMs: timeoutMs ?? 20000 },
      );
      return { ok: res.code === 0, stdout: res.stdout, stderr: res.stderr || res.error || "" };
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
    async listResidualProjects(env) {
      if (!(await dockerAvailable(env))) return [];
      const names = new Set<string>();
      const queries: string[][] = [
        ["volume", "ls", "--filter", `label=${COMPOSE_PROJECT_LABEL}`, "--format", `{{ index .Labels "${COMPOSE_PROJECT_LABEL}" }}`],
        ["network", "ls", "--filter", `label=${COMPOSE_PROJECT_LABEL}`, "--format", `{{ index .Labels "${COMPOSE_PROJECT_LABEL}" }}`],
        ["images", "--filter", `label=${COMPOSE_PROJECT_LABEL}`, "--format", `{{ index .Labels "${COMPOSE_PROJECT_LABEL}" }}`],
      ];
      for (const args of queries) {
        const res = await dockerExec(args, { env });
        if (res.code !== 0) continue;
        for (const line of res.stdout.split("\n")) {
          const name = line.trim();
          if (name) names.add(name);
        }
      }
      return [...names];
    },
    async removeResidualProjectResources(projectName, env) {
      if (!(await dockerAvailable(env))) {
        return { ok: false, stderr: "docker is not available on this host" };
      }
      const filter = `label=${COMPOSE_PROJECT_LABEL}=${projectName}`;
      let ok = true;
      const stderrParts: string[] = [];
      const removeByKind = async (listArgs: string[], removeCmd: (ids: string[]) => string[]) => {
        const listRes = await dockerExec(listArgs, { env });
        if (listRes.code !== 0) {
          ok = false;
          stderrParts.push(listRes.stderr || listRes.error || "");
          return;
        }
        const ids = listRes.stdout.split("\n").map((l) => l.trim()).filter(Boolean);
        if (ids.length === 0) return;
        const removeRes = await dockerExec(removeCmd(ids), { env });
        if (removeRes.code !== 0) {
          ok = false;
          stderrParts.push(removeRes.stderr || removeRes.error || "");
        }
      };
      await removeByKind(["volume", "ls", "-q", "--filter", filter], (ids) => ["volume", "rm", "-f", ...ids]);
      await removeByKind(["network", "ls", "-q", "--filter", filter], (ids) => ["network", "rm", ...ids]);
      await removeByKind(["images", "-q", "--filter", filter], (ids) => ["rmi", "-f", ...ids]);
      return { ok, stderr: stderrParts.filter(Boolean).join("; ") };
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
  /**
   * Resolve additional compose files (absolute paths) contributed by the workspace's
   * registered sibling repos that ship their own docker-compose.yml (#71). Injected for
   * testability; the default reads the workspace's repo rows and keeps only files that
   * exist on disk.
   */
  resolveExtraComposeFiles?: (workspaceId: string) => Promise<string[]>;
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
  const resolveExtraComposeFiles =
    deps.resolveExtraComposeFiles ??
    (async (workspaceId: string): Promise<string[]> => {
      const { listWorkspaceRepos } = await import("../repositories/repo.repository.js");
      const { existsSync } = await import("node:fs");
      const repos = await listWorkspaceRepos(workspaceId).catch(() => []);
      const files: string[] = [];
      for (const repo of repos) {
        if (!repo.composeFile || !repo.worktreePath) continue;
        const abs = join(repo.worktreePath, repo.composeFile);
        if (existsSync(abs)) files.push(abs);
        else console.warn(`[services] sibling ${repo.name ?? repo.path} declares composeFile '${repo.composeFile}' but ${abs} does not exist — skipping`);
      }
      return files;
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
    const declaredPortNames = (config.ports ?? []).filter((n) => n.trim().length > 0);
    // Additional compose files from sibling repos that ship their own stack (#71). They
    // join THIS workspace's compose project + env file and are torn down together by the
    // project-name `down`. Best-effort.
    const extraComposeFiles = await resolveExtraComposeFiles(workspaceId).catch(() => [] as string[]);
    // Sibling relative-path diagnostic (dev #109/#162): a merged sibling compose (`-f`)
    // that uses a relative env_file/build-context/dockerfile/secret+config-file/volumes
    // bind-mount path will have compose resolve it against the LEADING worktree
    // (composeWorktreePath), not the sibling — a failure whose "file not found under
    // <leading>" message is otherwise undiagnosable. Logged AND attached to the returned
    // state (below) so it survives past the server log into the persisted stack state +
    // ticket-context (#162). Best-effort, empty on the success path (siblings use no
    // relative paths, e.g. absolute or ${VAR} interpolated).
    const lintWarnings = await lintSiblingComposeFiles(composeWorktreePath, extraComposeFiles).catch(() => [] as string[]);
    // Union port allocation (#71): a sibling (or the primary) compose may publish ports the
    // project never declared in `servicesConfig.ports`. Discover every `${KANBAN_SVC_*_PORT}`
    // referenced across all compose files and allocate the union, so those services get a
    // free host port + env var instead of failing on an unset variable.
    const discoveredPortNames = await discoverComposePortNames(
      [join(composeWorktreePath, composeFile), ...extraComposeFiles],
      declaredPortNames,
    ).catch(() => [] as string[]);
    const portNames = [...declaredPortNames, ...discoveredPortNames];

    // The compose name is scoped to this instance's persisted id (see service-ports.ts)
    // so parallel board instances sharing the daemon never claim each other's stacks.
    let name: string;
    try {
      name = composeProjectName(workspaceId, await getInstanceId());
    } catch (err) {
      const message = errorMessage(err);
      return { composeProjectName: "", ports: {}, envFilePath, status: "error", error: `failed to resolve the service-stack instance id: ${message}`.slice(0, MAX_ERROR_CHARS), ...(lintWarnings.length ? { lintWarnings } : {}), updatedAt: new Date().toISOString() };
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
        const message = errorMessage(err);
        return { composeProjectName: name, ports, envFilePath, status: "error", error: message.slice(0, MAX_ERROR_CHARS), ...(lintWarnings.length ? { lintWarnings } : {}), updatedAt: new Date().toISOString() };
      }

      // `up -d --wait` with a bounded port-collision retry. A parallel create or the
      // host/dind namespace can still steal a port → "port is already allocated"; on that
      // specific failure we reallocate (drawing a fresh unused number from the range),
      // rewrite the env file, and retry (PORT-RETRY). Any partial containers from the
      // failed attempt are cleared with a best-effort down first.
      const MAX_UP_ATTEMPTS = 3; // initial + 2 retries
      let lastStderr = "";
      for (let attempt = 1; attempt <= MAX_UP_ATTEMPTS; attempt++) {
        const { ok, stderr } = await runner.up({ composeFile, extraComposeFiles, cwd: composeWorktreePath, projectName: name, envFile: envFilePath, timeoutMs });
        if (ok) {
          return { composeProjectName: name, ports, envFilePath, status: "up", ...(lintWarnings.length ? { lintWarnings } : {}), updatedAt: new Date().toISOString() };
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
          lastStderr = errorMessage(err);
          break;
        }
      }

      // F5(a): `up --wait` can start some containers then fail the health gate, leaving
      // them running. Run a best-effort compensating down so no partial stack lingers
      // before we return the error state.
      await runner.down({ projectName: name, cwd: composeWorktreePath }).catch(() => {});

      return { composeProjectName: name, ports, envFilePath, status: "error", error: (lastStderr || "compose up failed").slice(0, MAX_ERROR_CHARS), ...(lintWarnings.length ? { lintWarnings } : {}), updatedAt: new Date().toISOString() };
    } finally {
      releaseStackPorts(Object.values(ports));
    }
  }

  /**
   * The LAST-REFERENCE GUARD (shared worktrees, finding 12), factored out so every
   * path that can take a shared compose project down or bounce it (merge/delete/close
   * teardown AND the user-initiated Stop/Restart controls, #92/#161) consults the SAME
   * check instead of each re-deriving it. Co-resident workspaces (worktree reuse / fork
   * children) ADOPT one shared stack — several live rows can reference the same compose
   * project — so an action only proceeds when the ACTING workspace is the last live
   * referent. Returns the OTHER live sharers' ids (empty when none), or `null` when the
   * check itself failed (treated as "can't prove it's safe" by every caller).
   */
  async function findOtherLiveSharers(composeProjectName: string, actingWorkspaceId: string): Promise<string[] | null> {
    try {
      const refs = await findLiveStackReferences(composeProjectName);
      return refs.filter((r) => r.id !== actingWorkspaceId).map((r) => r.id);
    } catch (err) {
      console.warn(
        `[services] sharer check failed for ${composeProjectName} — treating as unsafe: ${errorMessage(err)}`,
      );
      return null;
    }
  }

  /**
   * Tear a workspace's stack down (`docker compose -p <name> down -v --remove-orphans`).
   * Best-effort and never throws — teardown runs on merge/delete/close paths that must
   * not be blocked by a docker hiccup. Takes the STORED compose project name (from the
   * persisted ServiceStackState) — NEVER a recomputed one — so it can never target the
   * wrong (or a sibling workspace's) stack (F1).
   *
   * Guarded by `findOtherLiveSharers`: the down only runs when the RELEASING workspace
   * is the last live referent; otherwise it is skipped (and the state stays "up",
   * because the stack IS up). `releasedByWorkspaceId` is REQUIRED and is the only way
   * the releaser is identified — an earlier fallback inferred it from the compose
   * name's owner token, which inverted the guard exactly for the adoption case it was
   * meant to protect (an adopter merging would `down -v` the live owner's stack and its
   * volumes). On a failed sharer check the down is skipped too (a leaked stack beats
   * downing a live shared one; the startup reaper reclaims true orphans).
   */
  async function teardownWorkspaceServices(args: {
    composeProjectName: string;
    composeWorktreePath: string;
    /** The workspace releasing the stack (excluded from the live-sharer count). */
    releasedByWorkspaceId: string;
  }): Promise<void> {
    const otherSharers = await findOtherLiveSharers(args.composeProjectName, args.releasedByWorkspaceId);
    if (otherSharers === null) return;
    if (otherSharers.length > 0) {
      console.log(
        `[services] stack ${args.composeProjectName} is still referenced by ${otherSharers.length} other live workspace(s) (${otherSharers.join(", ")}) — skipping the down (last sharer releases it)`,
      );
      return;
    }
    try {
      const { ok, stderr } = await runner.down({ projectName: args.composeProjectName, cwd: args.composeWorktreePath });
      // dockerExec never throws, so a failed down surfaces only here as ok:false (F6).
      if (!ok && stderr) {
        console.warn(`[services] teardown down for ${args.composeProjectName} reported failure (non-fatal): ${stderr}`);
      }
      // Persist status "down" onto EVERY row referencing this compose project (not just
      // the releaser's) so the workspace DTO stops reporting a downed stack as up (with
      // ports that may get reassigned). Only after a SUCCESSFUL down — a failed down may
      // have left containers running.
      if (ok) {
        await markServiceStateDown(args.composeProjectName);
      }
    } catch (err) {
      console.warn(`[services] teardown failed (non-fatal): ${errorMessage(err)}`);
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
   *
   * The inventory is the UNION of `runner.list()` (container-derived, `compose ls`) and
   * `runner.listResidualProjects()` (label-derived, sees volumes/networks/images with no
   * live container, #163). A name with containers still goes through `compose down -p`
   * (which resolves the project via container labels); a name that is residue-only
   * (containers already gone) is reaped via `removeResidualProjectResources` instead,
   * since `compose down -p` cannot resolve a project with no containers left at all.
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
      console.warn(`[services] reaper skipped — could not resolve this instance's id: ${errorMessage(err)}`);
      return { reaped };
    }
    let containerNames: string[] = [];
    try {
      containerNames = await runner.list();
    } catch (err) {
      console.warn(`[services] reaper list failed (non-fatal): ${errorMessage(err)}`);
      return { reaped };
    }
    let residualNames: string[] = [];
    try {
      residualNames = await runner.listResidualProjects();
    } catch (err) {
      console.warn(`[services] reaper residual-inventory query failed (non-fatal): ${errorMessage(err)}`);
    }
    const containerSet = new Set(containerNames);
    const allNames = new Set([...containerNames, ...residualNames]);
    for (const name of allNames) {
      if (!isInstanceManagedComposeProject(name, instanceId)) continue;
      if (args.knownComposeProjectNames.has(name)) continue;
      try {
        if (containerSet.has(name)) {
          await runner.down({ projectName: name, cwd: process.cwd() });
        } else {
          await runner.removeResidualProjectResources(name);
        }
        // A matching row can only be a terminal (closed) workspace's stale blob; mark
        // it down so it stops reporting a reaped stack as up. Best-effort.
        await markServiceStateDown(name).catch(() => {});
        reaped.push(name);
      } catch (err) {
        console.warn(`[services] reaper down failed for ${name} (non-fatal): ${errorMessage(err)}`);
      }
    }
    return { reaped };
  }

  async function resolveComposeInvocation(ctx: StackControlContext): Promise<{
    composeFile: string;
    extraComposeFiles: string[];
    timeoutMs: number;
  }> {
    const composeFile = ctx.config.composeFile || "docker-compose.yml";
    const extraComposeFiles = await resolveExtraComposeFiles(ctx.workspaceId).catch(() => [] as string[]);
    const timeoutMs = ctx.config.readyTimeoutMs ?? 120000;
    return { composeFile, extraComposeFiles, timeoutMs };
  }

  /** Fresh state carrying the SAME name/ports/env file as the stored one, minus stale flags. */
  function reusedState(ctx: StackControlContext, status: ServiceStackState["status"], error?: string): ServiceStackState {
    return {
      composeProjectName: ctx.state.composeProjectName,
      ports: ctx.state.ports,
      envFilePath: ctx.state.envFilePath,
      status,
      ...(error ? { error: error.slice(0, MAX_ERROR_CHARS) } : {}),
      updatedAt: new Date().toISOString(),
    };
  }

  /**
   * Bring an already-provisioned stack up again reusing the STORED env file (so the ports
   * are preserved — #92 "no reallocation on restart/start"). `forceRecreate` recreates the
   * containers (the "rebuild" control). Returns "up" on success, "error" (with the compose
   * stderr) on failure — the caller persists it.
   */
  async function startWorkspaceServices(ctx: StackControlContext, opts: { forceRecreate?: boolean } = {}): Promise<ServiceStackState> {
    const { composeFile, extraComposeFiles, timeoutMs } = await resolveComposeInvocation(ctx);
    const { ok, stderr } = await runner.up({
      composeFile,
      extraComposeFiles,
      cwd: ctx.composeWorktreePath,
      projectName: ctx.state.composeProjectName,
      envFile: ctx.state.envFilePath,
      timeoutMs,
      forceRecreate: opts.forceRecreate,
    });
    return reusedState(ctx, ok ? "up" : "error", ok ? undefined : stderr || "compose up failed");
  }

  /**
   * Stop a stack (`docker compose down` WITHOUT `-v`): remove the containers but keep the
   * named volumes, so a later START finds its data intact. Returns "down" on success.
   *
   * Guarded by `findOtherLiveSharers` (#161): the #92 control plane calls this directly
   * with no guard of its own, so on an ADOPTED (shared-worktree) stack a Stop click on
   * the adopter used to remove the donor's live containers out from under its running
   * agent. Throws `StackSharedInUseError` when another live workspace still references
   * the stack (or the sharer check itself failed) — the caller (the control service)
   * turns that into a CONFLICT the UI can show, instead of silently downing it.
   */
  async function stopWorkspaceServices(ctx: StackControlContext): Promise<ServiceStackState> {
    const otherSharers = await findOtherLiveSharers(ctx.state.composeProjectName, ctx.workspaceId);
    if (otherSharers === null || otherSharers.length > 0) {
      throw new StackSharedInUseError(ctx.state.composeProjectName, otherSharers ?? []);
    }
    const { ok, stderr } = await runner.down({
      projectName: ctx.state.composeProjectName,
      cwd: ctx.composeWorktreePath,
      removeVolumes: false,
    });
    // Stamp EVERY row referencing this compose project, not just the caller's — a
    // genuinely-last-reference down still leaves other (terminal) rows' persisted state
    // claiming "up" otherwise, which is what let the DTO/countLiveStacks/port exclusion
    // keep counting a dead stack as live.
    if (ok) await markServiceStateDown(ctx.state.composeProjectName);
    return reusedState(ctx, ok ? "down" : "error", ok ? undefined : stderr || "compose down failed");
  }

  /**
   * Restart a running stack (`docker compose restart`) — same containers, same ports.
   *
   * Guarded the same way as `stopWorkspaceServices` (#161): on an adopted stack a
   * restart bounces the SAME containers a donor workspace's agent depends on, so it
   * refuses (throws `StackSharedInUseError`) rather than restarting out from under a
   * live sharer.
   */
  async function restartWorkspaceServices(ctx: StackControlContext): Promise<ServiceStackState> {
    const otherSharers = await findOtherLiveSharers(ctx.state.composeProjectName, ctx.workspaceId);
    if (otherSharers === null || otherSharers.length > 0) {
      throw new StackSharedInUseError(ctx.state.composeProjectName, otherSharers ?? []);
    }
    const { composeFile, extraComposeFiles, timeoutMs } = await resolveComposeInvocation(ctx);
    const { ok, stderr } = await runner.restart({
      composeFile,
      extraComposeFiles,
      projectName: ctx.state.composeProjectName,
      cwd: ctx.composeWorktreePath,
      envFile: ctx.state.envFilePath,
      timeoutMs,
    });
    return reusedState(ctx, ok ? "up" : "error", ok ? undefined : stderr || "compose restart failed");
  }

  /** A bounded `docker compose logs --tail N` (never follows, so it never hangs — #92). */
  async function getWorkspaceServiceLogs(ctx: StackControlContext, tail: number): Promise<{ ok: boolean; logs: string }> {
    const { composeFile, extraComposeFiles } = await resolveComposeInvocation(ctx);
    const { ok, stdout, stderr } = await runner.logs({
      composeFile,
      extraComposeFiles,
      projectName: ctx.state.composeProjectName,
      cwd: ctx.composeWorktreePath,
      envFile: ctx.state.envFilePath,
      tail,
    });
    return { ok, logs: ok ? stdout || stderr : stderr || stdout };
  }

  return {
    provisionWorkspaceServices,
    teardownWorkspaceServices,
    reapOrphanServiceStacks,
    startWorkspaceServices,
    stopWorkspaceServices,
    restartWorkspaceServices,
    getWorkspaceServiceLogs,
  };
}

/** The lifecycle-control context type + a handle on the engine's control methods (#92). */
export type WorkspaceServicesEngine = ReturnType<typeof createWorkspaceServicesService>;

/**
 * Process-wide default instance (real docker driver), used by the create/teardown/
 * reaper wiring. Tests construct their own with a fake runner.
 */
export const workspaceServicesService = createWorkspaceServicesService();
