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
import { projects as projectsTable } from "@agentic-kanban/shared/schema";
import { eq } from "drizzle-orm";

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
 * A worker carrying this label shares the board's filesystem, so its
 * assignments skip git transport and run directly in the board-side worktree
 * (the phase-1c same-machine path). Absent = a true remote worker that must
 * clone from the board and push its result back.
 */
export const SHARES_FILESYSTEM_LABEL = "shares-filesystem";

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
    const workerId = await selectWorkerForLaunch(fleet, providerName, now);
    if (!workerId) {
      console.warn(
        `[worker-fleet] project ${projectId} wants worker dispatch but no eligible ${providerName} worker is available; launching on host`,
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
    const rows = await database
      .select({ repoPath: projectsTable.repoPath, defaultBranch: projectsTable.defaultBranch, setupScript: projectsTable.setupScript })
      .from(projectsTable)
      .where(eq(projectsTable.id, projectId))
      .limit(1);
    const project = rows[0];
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
    console.error(`[worker-fleet] placement resolution failed; launching on host`, err);
    return { kind: "host" };
  }
}
