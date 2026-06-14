import type { Database } from "../db/index.js";
import { createRouter } from "../middleware/create-router.js";
import { getProjectById } from "../repositories/project.repository.js";
import { getAllPreferences } from "../repositories/preferences.repository.js";
import { readOrchestratorStatus } from "../services/orchestrator-monitor.service.js";
import { resolveMonitorTunables } from "../services/strategy-objective.service.js";
import { resolveStartPolicy } from "../services/start-policy.service.js";
import { startConductor, stopConductor } from "../services/conductor-control.service.js";

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

  // Start/stop the out-of-process Conductor loop (dogfood board only). The Start Mode UI
  // calls this when the user picks "conductor" (start) vs manual/monitor (stop).
  router.post("/:id/conductor", async (c) => {
    const projectId = c.req.param("id");
    const project = await getProjectById(projectId, database);
    if (!project) return c.json({ error: "project not found" }, 404);
    const body = await c.req.json<{ action?: "start" | "stop"; agent?: "claude" | "codex" }>().catch(() => ({}));
    const repoPath = project.repoPath || "";
    if (body.action === "start") {
      const result = startConductor(repoPath, body.agent === "codex" ? "codex" : "claude");
      return c.json({ ...result, status: readOrchestratorStatus(repoPath) }, result.ok ? 200 : 409);
    }
    if (body.action === "stop") {
      const result = stopConductor(repoPath);
      return c.json({ ...result, status: readOrchestratorStatus(repoPath) });
    }
    return c.json({ error: "action must be 'start' or 'stop'" }, 400);
  });

  return router;
}
