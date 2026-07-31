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

/**
 * Pick the worker for a new launch: connected + effectively online (not
 * draining), provider available (an empty/absent provider list means "any"),
 * free capacity — least-loaded first. Null = no eligible worker.
 */
export async function selectWorkerForLaunch(
  fleet: WorkerFleet,
  providerName: ProviderName,
  now?: string,
): Promise<string | null> {
  const workers = await fleet.registry.listWorkersView(now);
  const candidates = workers
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
    .map((w) => ({ id: w.id, load: fleet.connections.runningSessionIds(w.id).length, cap: w.maxConcurrency }))
    .filter((w) => w.load < w.cap)
    .sort((a, b) => a.load - b.load);
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
  now?: string;
}): Promise<Placement> {
  const { database, projectId, providerName, now } = params;
  try {
    const pref = await getPreferenceValue(workerDispatchPrefKey(projectId), database);
    if (pref !== "true") return { kind: "host" };
    const fleet = getWorkerFleet(database);
    const workerId = await selectWorkerForLaunch(fleet, providerName, now);
    if (!workerId) {
      console.warn(
        `[worker-fleet] project ${projectId} wants worker dispatch but no eligible ${providerName} worker is available; launching on host`,
      );
      return { kind: "host" };
    }
    return { kind: "remote", workerId };
  } catch (err) {
    console.error(`[worker-fleet] placement resolution failed; launching on host`, err);
    return { kind: "host" };
  }
}
