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

  return router;
}
