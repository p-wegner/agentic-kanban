import type { Database } from "../db/index.js";
import { createRouter } from "../middleware/create-router.js";
import { listBoardHealthEvents, getBoardHealthEvent } from "../repositories/board-health-events.repository.js";
import {
  parseBoardHealthEventsLimit,
  parseBoardHealthEventTypes,
  parseBoardHealthCategories,
  toBoardHealthEventSummary,
  toBoardHealthEventDetail,
} from "../lib/board-health-events-format.js";
import { getProjectHealth } from "../services/project-health.service.js";
import { listBaseBranchHealth, getLatestBaseBranchHealth } from "../repositories/base-branch-health.repository.js";
import { verifyBaseBranchHealth, inFlightBaseBranchProbeCount } from "../services/base-branch-health.service.js";

import { queryInt } from "../middleware/query-params.js";
/**
 * Project health / board-health-event feature endpoints. Extracted from the
 * 400-commit routes/projects.ts grab-bag (arch-review §1.5). Mounted at the SAME
 * `/projects` prefix, so paths/behavior are unchanged — a move, not an API change.
 */
export function createProjectHealthRoute(database: Database) {
  const router = createRouter();

  // GET /api/projects/:id/board-health-events
  router.get("/:id/board-health-events", async (c) => {
    const projectId = c.req.param("id");
    const limit = parseBoardHealthEventsLimit(c.req.query("limit"));
    const eventTypes = parseBoardHealthEventTypes(c.req.query("eventType"));
    const categories = parseBoardHealthCategories(c.req.query("category"));
    const events = await listBoardHealthEvents({ projectId, eventTypes, categories, limit }, database);
    return c.json(events.map(toBoardHealthEventSummary));
  });

  // GET /api/projects/:id/board-health-events/:eventId — full event details (not compacted)
  router.get("/:id/board-health-events/:eventId", async (c) => {
    const projectId = c.req.param("id");
    const eventId = c.req.param("eventId");
    const event = await getBoardHealthEvent(eventId, database);
    if (!event || event.projectId !== projectId) return c.json({ error: "not found" }, 404);
    return c.json(toBoardHealthEventDetail(event));
  });

  // GET /api/projects/health — aggregated health overview for all registered projects
  router.get("/health", async (c) => {
    const result = await getProjectHealth(database);
    return c.json(result);
  });

  // GET /api/projects/:id/base-branch-health — latest + recent history of base-branch verify runs (#491)
  router.get("/:id/base-branch-health", async (c) => {
    const projectId = c.req.param("id");
    const limit = queryInt(c, "limit", { def: 20, min: 1, max: 100 });
    const [latest, history] = await Promise.all([
      getLatestBaseBranchHealth(projectId, database),
      listBaseBranchHealth(projectId, limit, database),
    ]);
    return c.json({ latest, history });
  });

  // POST /api/projects/:id/base-branch-health/reprobe — invalidate the cached verdict and
  // re-measure the base on demand (#935).
  //
  // Why this needs to exist: a probe that ran under machine saturation caches a TIMEOUT/RED
  // for the base, and until the periodic sweep next comes round (30 min, plus a full
  // PROBE_MAX_DURATION_MS extra back-off after a timeout — so up to ~90 minutes) every gate
  // failure in that window is prefixed with a verdict that a green master contradicts. There
  // was no way to say "that verdict was starved, measure again".
  //
  // Deliberately fire-and-forget: a probe is a clone + install + full verify, minutes to an
  // hour. Blocking the request on it would hold an HTTP connection for the whole run and time
  // out long before the answer. `verifyBaseBranchHealth` is per-project idempotent (the
  // in-flight map, #712), so a double-click JOINS the running probe rather than starting a
  // rival one — which is exactly what must not happen on an already-loaded box.
  router.post("/:id/base-branch-health/reprobe", async (c) => {
    const projectId = c.req.param("id");
    const previous = await getLatestBaseBranchHealth(projectId, database).catch(() => null);
    const alreadyRunning = inFlightBaseBranchProbeCount() > 0;
    void verifyBaseBranchHealth(projectId, database).catch((err) => {
      console.warn(
        `[base-branch-health] on-demand re-probe failed for project ${projectId} (non-fatal):`,
        err instanceof Error ? err.message : String(err),
      );
    });
    return c.json({
      started: true,
      joinedRunningProbe: alreadyRunning,
      // What the caller is replacing, so the response is self-explanatory in a log.
      previousOutcome: previous?.outcome ?? null,
      previousSha: previous?.sha ?? null,
      previousAt: previous?.createdAt ?? null,
    });
  });

  return router;
}
