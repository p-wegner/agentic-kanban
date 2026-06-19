import type { Database } from "../db/index.js";
import { createRouter } from "../middleware/create-router.js";
import { computeInsights, parseRange } from "../services/insights.service.js";

export function createInsightsRoute(database: Database) {
  const router = createRouter();

  router.get("/", async (c) => {
    const projectId = c.req.query("projectId");
    if (!projectId) return c.json({ error: "projectId query parameter required" }, 400);

    // `hours=N` is an exact sub-day window that takes precedence over `range`;
    // computeInsights ignores it when it isn't a finite positive number.
    const hoursParam = c.req.query("hours");
    const hours = hoursParam !== undefined ? Number(hoursParam) : undefined;
    const range = parseRange(c.req.query("range"));

    const data = await computeInsights(database, { projectId, range, hours });
    return c.json(data);
  });

  return router;
}
