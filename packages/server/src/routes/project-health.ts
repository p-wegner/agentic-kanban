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
import { inFlightBaseBranchProbeCount } from "../services/base-branch-health.service.js";
import { requestBaseBranchReprobe } from "../services/base-branch-health-reprobe.service.js";

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
  // out long before the answer.
  //
  // Routed through `requestBaseBranchReprobe` rather than the probe directly. As an explicit
  // operator request it overrides the RECENCY back-off (that override is the route's reason to
  // exist), but it still yields to the two machine guards — a probe already in flight, or a
  // merge gate spending the cores right now. Bypassing those would start a second 45-minute
  // verify on exactly the loaded box whose load produced the starved verdict being replaced.
  // The response says which of those happened instead of always claiming it started one.
  router.post("/:id/base-branch-health/reprobe", async (c) => {
    const projectId = c.req.param("id");
    const previous = await getLatestBaseBranchHealth(projectId, database).catch(() => null);
    const alreadyRunning = inFlightBaseBranchProbeCount() > 0;
    const verdict = await requestBaseBranchReprobe(projectId, database, undefined, undefined, {
      ignoreRecency: true,
    });
    return c.json({
      started: verdict.due,
      skippedReason: verdict.due ? null : verdict.reason,
      joinedRunningProbe: alreadyRunning,
      // What the caller is replacing, so the response is self-explanatory in a log.
      previousOutcome: previous?.outcome ?? null,
      previousSha: previous?.sha ?? null,
      previousAt: previous?.createdAt ?? null,
    });
  });

  return router;
}
