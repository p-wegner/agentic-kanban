// The compose engine for a workspace whose session runs on a fleet worker (#1447, part b of #1432):
// the same `WorkspaceServicesEngine`, wired to a `ComposeRunner` that executes on that worker. Null
// for a host-placed workspace, so the caller keeps its own engine and behaves exactly as before.
import type { Database } from "../db/index.js";
import { createWorkspaceServicesService, type WorkspaceServicesEngine } from "./workspace-services.service.js";
import { createRemoteComposeRunner } from "./workspace-services/remote-compose-runner.js";
import { resolveRemotePlacement } from "./workspace-remote-placement.js";
import { WorkspaceError } from "./workspace-internals.js";

export interface RemoteStack {
  engine: WorkspaceServicesEngine;
  workerId: string;
  /** Tell the proxy which worker-side ports the stack published (the card's links go through it). */
  registerPorts: (ports: Record<string, number>) => void;
}

export type RemoteStackResolver = (args: { workspaceId: string; composeWorktreePath: string; composeRepo?: string | null }) => Promise<RemoteStack | null>;

export function createRemoteStackResolver(database: Database): RemoteStackResolver {
  return async ({ workspaceId, composeWorktreePath, composeRepo }) => {
    const placement = await resolveRemotePlacement(workspaceId, database);
    if (!placement) return null;
    if (composeRepo) {
      throw new WorkspaceError(
        "A service stack whose compose file lives in a sibling repo cannot run on a fleet worker yet — the worker holds only the workspace's leading checkout.",
        "CONFLICT",
      );
    }
    const { client, workerId, sessionId } = placement;
    const runner = createRemoteComposeRunner({ client, workerId, sessionId, workspaceId, hostRoot: composeWorktreePath });
    return {
      workerId,
      // Sibling repos' compose files live in host worktrees the worker never sees.
      engine: createWorkspaceServicesService({ runner, resolveExtraComposeFiles: async () => [] }),
      registerPorts: (ports) => client.registerPorts({ workerId, sessionId, workspaceId, label: "compose", ports: Object.values(ports) }),
    };
  };
}
