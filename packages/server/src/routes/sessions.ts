import { Hono } from "hono";
import type { Database } from "../db/index.js";
import { createSessionReadService, SessionReadError } from "../services/session-read.service.js";

export function createSessionsRoute(database: Database) {
  const router = new Hono();
  const sessionReadService = createSessionReadService({ database });

  // GET /api/sessions/:sessionId/output
  router.get("/:sessionId/output", async (c) => {
    const sessionId = c.req.param("sessionId");
    try {
      return c.json(await sessionReadService.getOutput(sessionId));
    } catch (err) {
      if (err instanceof SessionReadError) return c.json({ error: err.message }, 404);
      throw err;
    }
  });

  // GET /api/sessions/:sessionId/stats
  router.get("/:sessionId/stats", async (c) => {
    const sessionId = c.req.param("sessionId");
    try {
      return c.json(await sessionReadService.getStats(sessionId));
    } catch (err) {
      if (err instanceof SessionReadError) return c.json({ error: err.message }, 404);
      if (err instanceof Error && err.message === "Invalid stats data") {
        return c.json({ error: "Invalid stats data" }, 500);
      }
      throw err;
    }
  });

  // GET /api/sessions/:sessionId/summary
  router.get("/:sessionId/summary", async (c) => {
    const sessionId = c.req.param("sessionId");
    try {
      return c.json(await sessionReadService.getSummary(sessionId));
    } catch (err) {
      if (err instanceof SessionReadError) return c.json({ error: err.message }, 404);
      throw err;
    }
  });

  return router;
}
