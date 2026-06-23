import type { Database } from "../db/index.js";
import { createRouter } from "../middleware/create-router.js";
import { getProjectById } from "../repositories/project.repository.js";
import { getAllPreferences, getPreference, setPreference } from "../repositories/preferences.repository.js";
import { readOrchestratorStatus } from "../services/orchestrator-monitor.service.js";
import { resolveMonitorTunables } from "../services/strategy-objective.service.js";
import { resolveProjectRuntimeConfig } from "../services/project-runtime-config.service.js";
import { conductorAvailable, startConductor, stopConductor } from "../services/conductor-control.service.js";
import {
  conductorCronPrefKey,
  parseConductorSchedule,
  resolveConductorSchedule,
  serializeConductorSchedule,
  type ConductorSchedule,
} from "../services/conductor-schedule.service.js";
import { validateCronExpression } from "@agentic-kanban/shared/lib/cron-utils";

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
    const runtime = resolveProjectRuntimeConfig({ projectId, prefMap });
    return c.json({ tunables, source, startPolicy: runtime.startPolicy });
  });

  // Start/stop the out-of-process Conductor loop (dogfood board only). The Start Mode UI
  // calls this when the user picks "conductor" (start) vs manual/monitor (stop).
  router.post("/:id/conductor", async (c) => {
    const projectId = c.req.param("id");
    const project = await getProjectById(projectId, database);
    if (!project) return c.json({ error: "project not found" }, 404);
    const body = await c.req
      .json<{ action?: "start" | "stop"; agent?: "claude" | "codex" }>()
      .catch((): { action?: "start" | "stop"; agent?: "claude" | "codex" } => ({}));
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

  // Cron schedule for the off-process Conductor (ticket #841). The continuous loop above
  // is always-on; this drives one off-process cycle per scheduled tick instead. Config is a
  // single per-project JSON preference; the minute scheduler (scheduled-tasks.ts) fires it.
  router.get("/:id/conductor-schedule", async (c) => {
    const projectId = c.req.param("id");
    const project = await getProjectById(projectId, database);
    if (!project) return c.json({ error: "project not found" }, 404);
    const raw = await getPreference(conductorCronPrefKey(projectId), database);
    return c.json({ available: conductorAvailable(project.repoPath || ""), schedule: resolveConductorSchedule(raw) });
  });

  router.put("/:id/conductor-schedule", async (c) => {
    const projectId = c.req.param("id");
    const project = await getProjectById(projectId, database);
    if (!project) return c.json({ error: "project not found" }, 404);
    const body = await c.req
      .json<{ enabled?: boolean; cron?: string; agent?: "claude" | "codex" }>()
      .catch(() => ({} as { enabled?: boolean; cron?: string; agent?: "claude" | "codex" }));

    const current = parseConductorSchedule(await getPreference(conductorCronPrefKey(projectId), database));
    const next: ConductorSchedule = {
      enabled: body.enabled ?? current.enabled,
      cron: body.cron !== undefined ? body.cron.trim() : current.cron,
      agent: body.agent === "codex" || body.agent === "claude" ? body.agent : current.agent,
      lastFiredAt: current.lastFiredAt, // server-owned; never overwritten by the UI
    };

    if (next.enabled && !next.cron) {
      return c.json({ error: "a cron expression is required to enable the schedule" }, 400);
    }
    if (next.cron) {
      const v = validateCronExpression(next.cron);
      if (!v.valid) return c.json({ error: v.error ?? "invalid cron expression" }, 400);
    }

    const serialized = serializeConductorSchedule(next);
    await setPreference(conductorCronPrefKey(projectId), serialized, database);
    return c.json({ available: conductorAvailable(project.repoPath || ""), schedule: resolveConductorSchedule(serialized) });
  });

  return router;
}
