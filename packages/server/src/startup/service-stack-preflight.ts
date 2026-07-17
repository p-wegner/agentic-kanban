/**
 * Boot preflight for the per-workspace Docker service-stack deployment (#55).
 *
 * DinD (the shipped `docker-compose.dind.yml`) works end-to-end. DooD (mounting the
 * host `/var/run/docker.sock` into a containerized board) is the trap: it is one
 * uncommented line away from LOOKING configured while being silently broken, and every
 * failure mode is quiet —
 *   1. `KANBAN_SERVICE_HOST` left at `localhost`: stacks come UP but the agent, inside
 *      the board container, cannot dial them (`localhost` there is the container, not
 *      the host). No error anywhere.
 *   2. The board's data root lives in a NAMED volume that does not exist on the host, so
 *      the host daemon resolves project bind-mount sources against a path it can't see
 *      and silently mounts an EMPTY directory instead of erroring.
 *
 * This module fails LOUDLY at boot instead: it classifies the deployment mode from the
 * environment and, in a detected DooD config, warns when the service host is undialable
 * and probes whether the daemon can actually see the data root. It NEVER blocks startup
 * (graceful degradation) — it only makes the silent broken states visible.
 *
 * The classifier is a pure function (fully unit-testable); the data-root probe and the
 * environment lookups are injected so tests need no docker.
 */

import { existsSync } from "node:fs";
import { dockerExec, dockerAvailable } from "@agentic-kanban/shared/lib/docker-exec";

export type DockerDeploymentMode = "native" | "dood" | "dind" | "unknown";

/** Is the service host one that only resolves inside the board's own container? */
function isUndialableServiceHost(serviceHost: string): boolean {
  const v = serviceHost.trim();
  return v === "" || v === "localhost" || v === "127.0.0.1";
}

/**
 * PURE deployment-mode classifier + the config-level warnings that can be derived
 * without touching docker. Inputs are all injectable so this is trivially testable:
 *  - `DOCKER_HOST` set                → DinD / remote daemon (published ports live in the
 *    daemon's netns; KANBAN_SERVICE_HOST must not be localhost).
 *  - host socket present + containerized board (IS_SANDBOX / /.dockerenv) → DooD (the
 *    #55 trap; localhost service host is undialable, and bind-mount sources are
 *    host-resolved).
 *  - otherwise                        → native (board shares the host namespace; localhost
 *    is correct).
 */
export function classifyDockerDeployment(args: {
  env: NodeJS.ProcessEnv;
  socketPresent: boolean;
  containerized: boolean;
}): { mode: DockerDeploymentMode; warnings: string[] } {
  const { env, socketPresent, containerized } = args;
  const dockerHost = env.DOCKER_HOST?.trim();
  const serviceHost = env.KANBAN_SERVICE_HOST ?? "";
  const warnings: string[] = [];

  if (dockerHost) {
    if (isUndialableServiceHost(serviceHost)) {
      warnings.push(
        `DOCKER_HOST is set (${dockerHost}) — service stacks publish their ports in the daemon's ` +
          `network namespace, but KANBAN_SERVICE_HOST is "${serviceHost || "unset"}" (localhost). Agents ` +
          `will not be able to reach any stack. Set KANBAN_SERVICE_HOST to the daemon-side host (e.g. ` +
          `"dind" for the shipped docker-compose.dind.yml).`,
      );
    }
    return { mode: "dind", warnings };
  }

  if (socketPresent && containerized) {
    if (isUndialableServiceHost(serviceHost)) {
      warnings.push(
        `DooD detected (host docker.sock mounted into a containerized board) but KANBAN_SERVICE_HOST is ` +
          `"${serviceHost || "unset"}" (localhost). Stacks will come UP but the agent cannot dial them — ` +
          `localhost inside the board container is not the host. Set KANBAN_SERVICE_HOST=host.docker.internal ` +
          `and add extra_hosts: ["host.docker.internal:host-gateway"] to the board service. (DinD via ` +
          `docker-compose.dind.yml avoids this entirely — it is the recommended path.)`,
      );
    }
    return { mode: "dood", warnings };
  }

  return { mode: "native", warnings };
}

export interface ServiceStackPreflightDeps {
  env?: NodeJS.ProcessEnv;
  /** Absolute path of the board's data root (bind-mount target in DooD). */
  dataRoot: string;
  /** Whether any project declares an enabled stack — the whole preflight is skipped if not. */
  hasEnabledStack: () => Promise<boolean>;
  /** Injectable overrides (tests). Defaults probe the real environment/daemon. */
  isDockerAvailable?: (env?: NodeJS.ProcessEnv) => Promise<boolean>;
  socketPresent?: boolean;
  containerized?: boolean;
  /**
   * Whether the DAEMON can see the data root. "empty" = it mounted an empty dir (the
   * broken-path state); "visible" = it saw content; "inconclusive" = the probe could not
   * run (image pull failed, timeout) — never warned on, to avoid false alarms.
   */
  probeDataRootVisible?: (dataRoot: string) => Promise<"visible" | "empty" | "inconclusive">;
  /** Sink for warnings (tests capture; default logs). */
  warn?: (message: string) => void;
}

/** Default host-socket presence check (Linux DooD mount point). */
function defaultSocketPresent(): boolean {
  return existsSync("/var/run/docker.sock");
}

/** Default containerized-board detection: the board image sets IS_SANDBOX=1; /.dockerenv
 *  is Docker's own in-container marker. Either is sufficient. */
function defaultContainerized(env: NodeJS.ProcessEnv): boolean {
  return env.IS_SANDBOX === "1" || existsSync("/.dockerenv");
}

/**
 * Default data-root visibility probe: bind-mount the data root into a throwaway busybox
 * and list it. Empty output ⇒ the daemon mounted an empty dir (path assumption broken).
 * Best-effort and bounded — any failure to RUN the probe is "inconclusive", never a
 * false warning.
 */
async function defaultProbeDataRootVisible(dataRoot: string): Promise<"visible" | "empty" | "inconclusive"> {
  const res = await dockerExec(
    ["run", "--rm", "-v", `${dataRoot}:/probe:ro`, "busybox", "sh", "-c", "ls -A /probe | head -1"],
    { timeoutMs: 30000 },
  );
  if (res.code !== 0) return "inconclusive";
  return res.stdout.trim().length > 0 ? "visible" : "empty";
}

/**
 * Run the boot preflight. No-op (and cheap) unless a stack is declared AND docker is
 * available. Never throws — logs warnings for the silent DooD traps and returns a
 * summary for callers/tests. Does NOT block provisioning (graceful degradation, decision
 * 011): a broken DooD config is surfaced, not enforced.
 */
export async function runServiceStackPreflight(
  deps: ServiceStackPreflightDeps,
): Promise<{ ran: boolean; mode: DockerDeploymentMode; warnings: string[] }> {
  const env = deps.env ?? process.env;
  const warn = deps.warn ?? ((m: string) => console.warn(`[services-preflight] ${m}`));
  try {
    if (!(await deps.hasEnabledStack())) return { ran: false, mode: "unknown", warnings: [] };

    const isDockerAvailable = deps.isDockerAvailable ?? dockerAvailable;
    if (!(await isDockerAvailable(env))) return { ran: false, mode: "unknown", warnings: [] };

    const socketPresent = deps.socketPresent ?? defaultSocketPresent();
    const containerized = deps.containerized ?? defaultContainerized(env);
    const { mode, warnings } = classifyDockerDeployment({ env, socketPresent, containerized });

    // Data-root visibility only matters in DooD (host daemon != board fs). DinD shares
    // the volume at an identical path; native shares the fs.
    if (mode === "dood") {
      const probe = deps.probeDataRootVisible ?? defaultProbeDataRootVisible;
      const visibility = await probe(deps.dataRoot);
      if (visibility === "empty") {
        warnings.push(
          `The Docker daemon cannot see the board's data root (${deps.dataRoot}) — it mounted an EMPTY ` +
            `directory. Project bind-mount sources will silently mount empty. In DooD the data root must be ` +
            `a HOST bind-mount at an identical path both sides (e.g. - /srv/kanban-data:/data), not a named ` +
            `volume. (Or use DinD via docker-compose.dind.yml, which shares the volume at the same path.)`,
        );
      }
    }

    for (const w of warnings) warn(w);
    if (warnings.length > 0) {
      warn(`service-stack deployment preflight found ${warnings.length} issue(s) (mode: ${mode}). Stacks may not be reachable by agents; see the warnings above.`);
    }
    return { ran: true, mode, warnings };
  } catch (err) {
    warn(`preflight failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
    return { ran: false, mode: "unknown", warnings: [] };
  }
}
