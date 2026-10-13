import type { Database } from "../db/index.js";
import { createRouter } from "../middleware/create-router.js";
import { createWorkspaceService } from "../services/workspace.service.js";
import { createWorkspaceDevServerService } from "../services/workspace-dev-server.service.js";

/**
 * A workspace's dev server (#1447): runs on the worker holding the workspace's session when it has
 * one, on the board host otherwise. `url` is the board's proxy path for a worker-side server.
 */
export function createWorkspaceDevServerRoute(database: Database) {
  const router = createRouter();
  const workspaceService = createWorkspaceService({ database });
  const service = createWorkspaceDevServerService({ database, getPlan: (id) => workspaceService.getWorkspaceDevServerPlan(id) });

  // GET /api/workspaces/:id/dev-server — where it runs, whether it is reachable, and the link to open.
  router.get("/:id/dev-server", async (c) => c.json(await service.status(c.req.param("id"))));

  // POST /api/workspaces/:id/dev-server/start — start it on the worker holding the session (or the host).
  router.post("/:id/dev-server/start", async (c) => c.json(await service.start(c.req.param("id"))));

  // POST /api/workspaces/:id/dev-server/stop
  router.post("/:id/dev-server/stop", async (c) => c.json(await service.stop(c.req.param("id"))));

  return router;
}
