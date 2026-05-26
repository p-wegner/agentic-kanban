import { db } from "../db/index.js";
import type { Database } from "../db/index.js";
import { createSessionReadService } from "../services/session-read.service.js";
import { createRouter } from "../middleware/create-router.js";

export function createSessionsRoute(database: Database = db) {
  const router = createRouter();
  const sessionReadService = createSessionReadService({ database });

  // GET /api/sessions/:sessionId/output
  router.get("/:sessionId/output", async (c) => {
    const sessionId = c.req.param("sessionId");
    return c.json(await sessionReadService.getOutput(sessionId));
  });

  // GET /api/sessions/:sessionId/stats
  router.get("/:sessionId/stats", async (c) => {
    const sessionId = c.req.param("sessionId");
    return c.json(await sessionReadService.getStats(sessionId));
  });

  // GET /api/sessions/:sessionId/summary
  router.get("/:sessionId/summary", async (c) => {
    const sessionId = c.req.param("sessionId");
    return c.json(await sessionReadService.getSummary(sessionId));
  });

  return router;
}
