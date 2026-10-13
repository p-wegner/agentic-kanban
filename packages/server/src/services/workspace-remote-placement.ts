// Where a workspace's builder runs decides where its dev server, script shortcuts and compose stack
// run (#1447, part b of #1432): a session on a fleet worker has its installed checkout THERE, and the
// host's worktree for it has no dependencies (#1429). This is the one place that answers "which
// worker, which session, and is it still connected", plus the URL the card links to.
import type { Database } from "../db/index.js";
import { getLatestSessionPlacement } from "../repositories/session.repository.js";
import { getWorkerServicesClient, type RemoteServiceRecord, type WorkerServicesClient } from "./worker-services-client.js";
import { WorkspaceError } from "./workspace-internals.js";

export interface RemotePlacement {
  workerId: string;
  /** The workspace's session on that worker: names the checkout the worker runs services in. */
  sessionId: string;
  client: WorkerServicesClient;
}

/** Every client that ever started something, so teardown never builds a fleet just to find nothing. */
const activeClients = new Set<WorkerServicesClient>();

/**
 * The worker holding this workspace's session, or null when it is host-placed (no session, or the
 * latest session ran on the host). A worker-placed workspace whose worker is NOT connected throws
 * rather than returning null: falling back to the host would start the dev server against a
 * worktree that has no installed dependencies.
 */
export async function resolveRemotePlacement(workspaceId: string, database: Database): Promise<RemotePlacement | null> {
  const latest = await getLatestSessionPlacement(workspaceId, database);
  if (!latest?.workerId) return null;
  // Lazy: the fleet bundle is heavy and this module sits under the workspace terminal paths.
  const { getWorkerFleet } = await import("./worker-fleet.service.js");
  const fleet = getWorkerFleet(database);
  if (!fleet.connections.isConnected(latest.workerId)) {
    throw new WorkspaceError(
      `This workspace's session runs on fleet worker ${latest.workerId}, which is not connected — its dev server and service stack cannot be reached right now.`,
      "CONFLICT",
    );
  }
  const client = getWorkerServicesClient(fleet.connections);
  activeClients.add(client);
  return { workerId: latest.workerId, sessionId: latest.sessionId, client };
}

/** What the board believes a workspace runs on workers — including `unreachable` ones, which no live placement would show. */
export function listRemoteServices(workspaceId: string): RemoteServiceRecord[] {
  return [...activeClients].flatMap((c) => c.listServices(workspaceId));
}

/** The service of this workspace that registered `port`, with the client that reaches its worker (the proxy's allowlist). */
export function findRemoteServiceByPort(workspaceId: string, port: number): { record: RemoteServiceRecord; client: WorkerServicesClient } | null {
  for (const client of activeClients) {
    const record = client.listServices(workspaceId).find((s) => s.ports.includes(port));
    if (record) return { record, client };
  }
  return null;
}

/** The clients that own workers' services (to stop what a lost placement can no longer resolve). */
export function remoteClients(): WorkerServicesClient[] {
  return [...activeClients];
}

/** The board-proxied URL for a worker-side port of a workspace (`/api/workspaces/:id/proxy/<port>/`). */
export function workspaceProxyPath(workspaceId: string, port: number): string {
  return `/api/workspaces/${encodeURIComponent(workspaceId)}/proxy/${port}/`;
}

/**
 * Stop everything the workspace runs on any worker (dev server, scripts, compose stack). Called from
 * the workspace's terminal paths. `composeProjectName` is the stored compose name: when the stack was
 * brought up on a worker, it is brought down there, and the caller must NOT also tear it down on the
 * host. Best-effort — a lost worker has already stopped caring.
 */
export async function releaseRemoteWorkspaceServices(
  workspaceId: string,
  composeProjectName: string | null,
): Promise<{ remoteStackReleased: boolean }> {
  let remoteStackReleased = false;
  for (const client of activeClients) {
    const records = client.listServices(workspaceId);
    for (const workerId of new Set(records.map((r) => r.workerId))) {
      const compose = records.find((r) => r.workerId === workerId && r.label === "compose");
      if (compose && composeProjectName) {
        const down = await client.exec({
          workerId, sessionId: compose.sessionId, workspaceId, label: "compose-down", scratch: true,
          argv: ["docker", "compose", "-p", composeProjectName, "down", "-v", "--rmi", "local", "--remove-orphans"],
          timeoutMs: 120_000,
        });
        remoteStackReleased = remoteStackReleased || down.ok;
      }
      await client.stopServices(workerId, workspaceId);
      console.log(`[workspace-services] stopped workspace ${workspaceId}'s services on worker ${workerId}`);
    }
  }
  return { remoteStackReleased };
}
