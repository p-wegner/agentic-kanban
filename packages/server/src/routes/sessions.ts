import { Hono } from "hono";
import { db } from "../db/index.js";
import type { Database } from "../db/index.js";
import { getSessionOutput, getSessionStats, getSessionSummaryData } from "../repositories/session.repository.js";

export function createSessionsRoute(database: Database = db) {
  const router = new Hono();

  // GET /api/sessions/:sessionId/output
  router.get("/:sessionId/output", async (c) => {
    const sessionId = c.req.param("sessionId");
    const result = await getSessionOutput(sessionId, database);
    if (!result) return c.json({ error: "Session not found" }, 404);
    return c.json(result.messages);
  });

  // GET /api/sessions/:sessionId/stats
  router.get("/:sessionId/stats", async (c) => {
    const sessionId = c.req.param("sessionId");
    try {
      const result = await getSessionStats(sessionId, database);
      if (result.status === "not_found") return c.json({ error: "Session not found" }, 404);
      if (result.status === "no_stats") return c.json({ error: "No stats available" }, 404);
      return c.json(result.stats);
    } catch (err) {
      if (err instanceof Error && err.message === "Invalid stats data") {
        return c.json({ error: "Invalid stats data" }, 500);
      }
      throw err;
    }
  });

  // GET /api/sessions/:sessionId/summary
  router.get("/:sessionId/summary", async (c) => {
    const sessionId = c.req.param("sessionId");
    const result = await getSessionSummaryData(sessionId, database);
    if (!result) return c.json({ error: "Session not found" }, 404);
    return c.json(result);
  });

  return router;
}
