import type { Database } from "../db/index.js";
import { createRouter } from "../middleware/create-router.js";
import { getProjectById } from "../repositories/project.repository.js";
import { getAllPreferences } from "../repositories/preferences.repository.js";
import { readOrchestratorStatus } from "../services/orchestrator-monitor.service.js";
import { resolveMonitorTunables } from "../services/strategy-objective.service.js";
import { resolveStartPolicy } from "../services/start-policy.service.js";

/**
 * Read-only observability for the detached board-monitor orchestrator loop
 * (scripts/board-monitor/). Mounted under /projects.
 *
 * GET /api/projects/:id/orchestrator → OrchestratorStatus for that project's repo.
 * Returns `available: false` for any repo without scripts/board-monitor/loop.sh,
 * so the UI strip stays hidden for normal installs (which use the in-process monitor).
 *
 * GET /api/projects/:id/monitor-tunables → the resolved effective tunables with source.
 * Lets the UI show which control surface (Strategy Bullseye vs legacy prefs) is driving
 * the in-process monitor so users understand why editing nudge_wip_limit has no effect.
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

  router.get("/:id/monitor-tunables", async (c) => {
    const projectId = c.req.param("id");
    const project = await getProjectById(projectId, database);
    if (!project) {
      return c.json({ error: "project not found" }, 404);
    }
    const rows = await getAllPreferences(database);
    const prefMap = new Map(rows.map((r) => [r.key, r.value]));
    const { tunables, source } = resolveMonitorTunables(prefMap, projectId);
    const startPolicy = resolveStartPolicy(prefMap, projectId);
    return c.json({ tunables, source, startPolicy });
  });

  return router;
}
