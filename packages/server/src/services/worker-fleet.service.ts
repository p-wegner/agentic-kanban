// Worker-fleet facade (epic #1, phase 1c #5): one shared bundle per database of
// the registry (auth + rows), the connection manager (live sockets) and the
// remote execution service — so the REST routes, the WS route and the session
// lifecycle all see the SAME fleet state in one board process.

import { db as realDb } from "../db/index.js";
import type { Database } from "../db/index.js";
import { getPreferenceValue } from "../repositories/session-lifecycle.repository.js";
import type { Placement } from "./agent-dispatch.service.js";
import { createRemoteAgentService } from "./agent-remote.service.js";
import type { AgentExecutionService } from "./agent-dispatch.service.js";
import { createWorkerConnectionManager, type WorkerConnectionManager } from "./worker-connection.service.js";
import { getWorkerRegistry, type WorkerRegistry } from "./worker-registry.service.js";
import type { ProviderName } from "./agent-provider.js";
import { getProjectById } from "../repositories/project.repository.js";
// Canonical home is the dependency-free protocol module, so the worker CLI can
// name the label without importing this service's graph. Re-exported here for
// existing importers.
import { SHARES_FILESYSTEM_LABEL } from "@agentic-kanban/shared/lib/worker-protocol";
export { SHARES_FILESYSTEM_LABEL };

/** Strict-mode refusal: dispatch was required but no worker could take the work. */
export class WorkerDispatchUnavailableError extends Error {
  readonly code = "NO_AVAILABLE_WORKER";
  constructor(message: string) {
    super(message);
    this.name = "WorkerDispatchUnavailableError";
  }
}

export interface WorkerFleet {
  registry: WorkerRegistry;
  connections: WorkerConnectionManager;
  remoteAgentService: AgentExecutionService;
}

const fleetByDb = new WeakMap<object, WorkerFleet>();

export function getWorkerFleet(database: Database = realDb): WorkerFleet {
  let fleet = fleetByDb.get(database as object);
  if (!fleet) {
    const registry = getWorkerRegistry(database);
    const connections = createWorkerConnectionManager(registry);
    fleet = {
      registry,
      connections,
      remoteAgentService: createRemoteAgentService(connections, database),
    };
    fleetByDb.set(database as object, fleet);
  }
  return fleet;
}

export function workerDispatchPrefKey(projectId: string): string {
  return `worker_dispatch_${projectId}`;
}

/** CSV of labels a worker must carry to run this project's work (e.g. "docker,linux"). */
export function workerLabelsPrefKey(projectId: string): string {
  return `worker_labels_${projectId}`;
}

/**
 * When "true", the project REFUSES to fall back to the board host: with no
 * eligible worker the monitor skips the start (reason `no_available_worker`)
 * instead of running the agent locally. Mirrors devcontainer_strict.
 */
export function workerStrictPrefKey(projectId: string): string {
  return `worker_dispatch_strict_${projectId}`;
}

export function parseRequiredLabels(pref: string | undefined): string[] {
  return (pref ?? "").split(",").map((s) => s.trim()).filter(Boolean);
}

export interface FleetCapacity {
  /** Workers connected, online and matching the filters. */
  eligibleWorkers: number;
  /** Sum of their remaining concurrency — how many more sessions the fleet can take. */
  freeSlots: number;
}

/** Aggregate free capacity for a provider + label requirement. */
export async function resolveFleetCapacity(
  fleet: WorkerFleet,
  providerName: ProviderName,
  requiredLabels: string[] = [],
  now?: string,
): Promise<FleetCapacity> {
  const candidates = await eligibleWorkers(fleet, providerName, requiredLabels, now);
  return {
    eligibleWorkers: candidates.length,
    freeSlots: candidates.reduce((sum, w) => sum + Math.max(0, w.cap - w.load), 0),
  };
}

function parseLabels(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((l): l is string => typeof l === "string") : [];
  } catch {
    return [];
  }
}

export async function workerSharesFilesystem(fleet: WorkerFleet, workerId: string, now?: string): Promise<boolean> {
  const worker = (await fleet.registry.listWorkersView(now)).find((w) => w.id === workerId);
  return parseLabels(worker?.labels ?? null).includes(SHARES_FILESYSTEM_LABEL);
}

/**
 * Pick the worker for a new launch: connected + effectively online (not
 * draining), provider available (an empty/absent provider list means "any"),
 * free capacity — least-loaded first. Null = no eligible worker.
 */
async function eligibleWorkers(
  fleet: WorkerFleet,
  providerName: ProviderName,
  requiredLabels: string[],
  now?: string,
): Promise<Array<{ id: string; load: number; cap: number }>> {
  const workers = await fleet.registry.listWorkersView(now);
  return workers
    .filter((w) => w.effectiveStatus === "online")
    .filter((w) => fleet.connections.isConnected(w.id))
    .filter((w) => {
      if (!w.providers) return true;
      try {
        const list = JSON.parse(w.providers) as string[];
        return list.length === 0 || list.includes(providerName);
      } catch {
        return true;
      }
    })
    .filter((w) => {
      if (requiredLabels.length === 0) return true;
      const labels = parseLabels(w.labels);
      return requiredLabels.every((required) => labels.includes(required));
    })
    .map((w) => ({ id: w.id, load: fleet.connections.runningSessionIds(w.id).length, cap: w.maxConcurrency }))
    .filter((w) => w.load < w.cap)
    .sort((a, b) => a.load - b.load);
}

export async function selectWorkerForLaunch(
  fleet: WorkerFleet,
  providerName: ProviderName,
  requiredLabels: string[] = [],
  now?: string,
): Promise<string | null> {
  const candidates = await eligibleWorkers(fleet, providerName, requiredLabels, now);
  return candidates[0]?.id ?? null;
}

/**
 * Placement policy for a builder launch (generalizes the devcontainer
 * provision decision): remote only when the project opted in via
 * `worker_dispatch_<projectId>` AND an eligible worker is available; anything
 * else degrades loudly to host — never blocks a launch.
 */
export async function resolveWorkerPlacement(params: {
  database: Database;
  projectId: string;
  providerName: ProviderName;
  /** Workspace branch info — required to give a true remote worker git transport. */
  branch?: string;
  baseBranch?: string;
  now?: string;
}): Promise<Placement> {
  const { database, projectId, providerName, branch, baseBranch, now } = params;
  try {
    const pref = await getPreferenceValue(workerDispatchPrefKey(projectId), database);
    if (pref !== "true") return { kind: "host" };
    const fleet = getWorkerFleet(database);
    const requiredLabels = parseRequiredLabels(await getPreferenceValue(workerLabelsPrefKey(projectId), database));
    const workerId = await selectWorkerForLaunch(fleet, providerName, requiredLabels, now);
    if (!workerId) {
      const detail = requiredLabels.length > 0 ? ` with labels [${requiredLabels.join(",")}]` : "";
      const strict = (await getPreferenceValue(workerStrictPrefKey(projectId), database)) === "true";
      if (strict) {
        throw new WorkerDispatchUnavailableError(
          `no eligible ${providerName} worker${detail} for project ${projectId} and worker dispatch is strict`,
        );
      }
      console.warn(
        `[worker-fleet] project ${projectId} wants worker dispatch but no eligible ${providerName} worker${detail} is available; launching on host`,
      );
      return { kind: "host" };
    }
    if (await workerSharesFilesystem(fleet, workerId, now)) {
      return { kind: "remote", workerId };
    }

    // True remote worker: it needs the repo over git transport. Without a
    // branch to push back (e.g. a direct workspace with no feature branch)
    // there is nothing safe to dispatch remotely — stay on the host.
    if (!branch) {
      console.warn(`[worker-fleet] remote worker ${workerId} needs a branch for git transport; launching on host`);
      return { kind: "host" };
    }
    const project = await getProjectById(projectId, database);
    if (!project?.repoPath) {
      console.warn(`[worker-fleet] project ${projectId} has no repoPath; launching on host`);
      return { kind: "host" };
    }
    return {
      kind: "remote",
      workerId,
      repo: {
        projectId,
        repoPath: project.repoPath,
        branch,
        baseBranch: baseBranch || project.defaultBranch || "master",
        setupScript: project.setupScript ?? undefined,
      },
    };
  } catch (err) {
    // Strict mode is a deliberate refusal, not a resolution failure — propagate it
    // so the caller surfaces "no worker" instead of silently running on the host.
    if (err instanceof WorkerDispatchUnavailableError) throw err;
    console.error(`[worker-fleet] placement resolution failed; launching on host`, err);
    return { kind: "host" };
  }
}

/**
 * Would this project's next launch find a worker? Used by the monitor to skip a
 * start (reason `no_available_worker`) instead of queuing work that strict-mode
 * placement would refuse. Non-strict projects always report available (they can
 * fall back to the host).
 */
export async function projectCanDispatch(params: {
  database: Database;
  projectId: string;
  providerName: ProviderName;
  now?: string;
}): Promise<{ available: true } | { available: false; reason: string }> {
  const { database, projectId, providerName, now } = params;
  try {
    if ((await getPreferenceValue(workerDispatchPrefKey(projectId), database)) !== "true") return { available: true };
    if ((await getPreferenceValue(workerStrictPrefKey(projectId), database)) !== "true") return { available: true };
    const fleet = getWorkerFleet(database);
    const requiredLabels = parseRequiredLabels(await getPreferenceValue(workerLabelsPrefKey(projectId), database));
    const capacity = await resolveFleetCapacity(fleet, providerName, requiredLabels, now);
    if (capacity.freeSlots > 0) return { available: true };
    const detail = requiredLabels.length > 0 ? ` matching [${requiredLabels.join(",")}]` : "";
    return { available: false, reason: `no fleet worker${detail} has free capacity` };
  } catch (err) {
    console.error(`[worker-fleet] dispatch availability check failed; treating as available`, err);
    return { available: true };
  }
}
