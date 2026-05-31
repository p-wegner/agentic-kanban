import type { Database } from "../db/index.js";
import { createRouter } from "../middleware/create-router.js";
import { getProjectById } from "../repositories/project.repository.js";
import { readOrchestratorStatus } from "../services/orchestrator-monitor.service.js";

/**
 * Read-only observability for the detached board-monitor orchestrator loop
 * (scripts/board-monitor/). Mounted under /projects.
 *
 * GET /api/projects/:id/orchestrator → OrchestratorStatus for that project's repo.
 * Returns `available: false` for any repo without scripts/board-monitor/loop.sh,
 * so the UI strip stays hidden for normal installs (which use the in-process monitor).
 */
export function createBoardMonitorRoute(database: Database) {
  const router = createRouter();

  router.get("/:id/orchestrator", async (c) => {
    const projectId = c.req.param("id");
    const project = await getProjectById(projectId, database);
    if (!project) {
      return c.json({ available: false, error: "project not found" }, 404);
    }
    return c.json(readOrchestratorStatus(project.repoPath));
  });

  return router;
}
