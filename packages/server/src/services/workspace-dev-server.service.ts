// Start / stop / inspect a WORKSPACE's dev server (#1447, part b of #1432).
//
// A workspace whose builder is placed on a fleet worker runs its dev server ON that worker, in the
// worker's checkout of the workspace branch, and the card links to it through the board's proxy
// (`/api/workspaces/:id/proxy/<port>/`, see routes/workspace-proxy.ts). A host-placed workspace
// behaves as it always did: the command runs in the host worktree and the link is the plain
// loopback URL. In neither case does the other side start anything — a worker-placed workspace
// never spawns a dev server on the host.
import type { DevServerPlan, WorkspaceDevServerPlanResponse, WorkspaceDevServerStatusResponse } from "@agentic-kanban/shared";
import type { Database } from "../db/index.js";
import { getWorkspaceById } from "../repositories/workspace.repository.js";
import { startDevServer, stopDevServer } from "./dev-server.service.js";
import { listRemoteServices, remoteClients, resolveRemotePlacement, workspaceProxyPath } from "./workspace-remote-placement.js";
import { WorkspaceError } from "./workspace-internals.js";

export const DEV_SERVER_LABEL = "devserver";

/** `url` is what the card's "open" link points at: the board proxy for a worker, loopback for the host. */
export type WorkspaceDevServerStatus = WorkspaceDevServerStatusResponse;

interface HostRun { pid: number | null; plan: DevServerPlan }

/** Dev servers the board started on ITS OWN machine, by workspace (the pre-#1447 behaviour). */
const hostRuns = new Map<string, HostRun>();

/** The workspace's dev server as the board knows it on a worker (in memory, no placement lookup), or null. */
export function remoteDevServerStatus(workspaceId: string): WorkspaceDevServerStatus | null {
  const remote = listRemoteServices(workspaceId).find((s) => s.label === DEV_SERVER_LABEL);
  if (!remote) return null;
  const port = remote.ports[0] ?? null;
  return { workspaceId, where: "worker", workerId: remote.workerId, status: remote.status, command: null, port, url: port != null ? workspaceProxyPath(workspaceId, port) : null };
}

export function createWorkspaceDevServerService(deps: {
  database: Database;
  getPlan: (workspaceId: string) => Promise<WorkspaceDevServerPlanResponse | null>;
  /** Test seams. */
  startHost?: typeof startDevServer;
  stopHost?: typeof stopDevServer;
}) {
  const { database } = deps;
  const startHost = deps.startHost ?? startDevServer;
  const stopHost = deps.stopHost ?? stopDevServer;

  async function status(workspaceId: string): Promise<WorkspaceDevServerStatus> {
    const remote = remoteDevServerStatus(workspaceId);
    if (remote) return remote;
    const host = hostRuns.get(workspaceId);
    if (host) {
      const port = host.plan.port;
      return { workspaceId, where: "host", workerId: null, status: "running", command: host.plan.command, port, url: port != null ? (host.plan.healthUrl ?? `http://127.0.0.1:${port}/`) : null };
    }
    return { workspaceId, where: null, workerId: null, status: "stopped", command: null, port: null, url: null };
  }

  async function start(workspaceId: string): Promise<WorkspaceDevServerStatus> {
    const workspace = await getWorkspaceById(workspaceId, database);
    if (!workspace) throw new WorkspaceError("Workspace not found", "NOT_FOUND");
    const plan = (await deps.getPlan(workspaceId))?.plan ?? null;
    if (!plan) throw new WorkspaceError("This project has no dev command configured (set dev_command or detect a stack profile)", "BAD_REQUEST");

    const placement = await resolveRemotePlacement(workspaceId, database);
    if (placement) {
      const result = await placement.client.startProcess({
        workerId: placement.workerId, sessionId: placement.sessionId, workspaceId, label: DEV_SERVER_LABEL,
        command: plan.command, ports: plan.port != null ? [plan.port] : [],
      });
      if (!result.ok) throw new WorkspaceError(`Could not start the dev server on worker ${placement.workerId}: ${result.error ?? "unknown error"}`, "CONFLICT");
      console.log(`[workspace-dev-server] started the dev server for workspace ${workspaceId} on worker ${placement.workerId} (pid ${result.pid ?? "?"}, port ${plan.port ?? "none"})`);
      return status(workspaceId);
    }

    if (!workspace.workingDir) throw new WorkspaceError("Workspace has no worktree to run a dev server in", "BAD_REQUEST");
    const started = startHost(plan, workspace.workingDir, { logLabel: `workspace-${workspaceId}` });
    hostRuns.set(workspaceId, { pid: started.pid, plan });
    console.log(`[workspace-dev-server] started the dev server for workspace ${workspaceId} on the board host (pid ${started.pid ?? "?"})`);
    return status(workspaceId);
  }

  async function stop(workspaceId: string): Promise<WorkspaceDevServerStatus> {
    const remote = listRemoteServices(workspaceId).find((s) => s.label === DEV_SERVER_LABEL);
    if (remote) {
      for (const client of remoteClients()) await client.stopServices(remote.workerId, workspaceId, DEV_SERVER_LABEL);
      console.log(`[workspace-dev-server] stopped the dev server for workspace ${workspaceId} on worker ${remote.workerId}`);
    }
    const host = hostRuns.get(workspaceId);
    if (host) {
      hostRuns.delete(workspaceId);
      await stopHost(host.plan);
    }
    return status(workspaceId);
  }

  return { start, stop, status };
}

export type WorkspaceDevServerService = ReturnType<typeof createWorkspaceDevServerService>;
