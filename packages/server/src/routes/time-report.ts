import type { Database } from "../db/index.js";
import { createRouter } from "../middleware/create-router.js";
import { computeTimeReport, parseRange } from "../services/time-report.service.js";

// #606: the aggregation moved to services/time-report.service.ts; this route is the thin
// adapter the layering calls for. Types are re-exported for existing importers.
export type {
  TimeReportRange,
  TimeReportByIssue,
  TimeReportByDay,
  TimeReportData,
} from "../services/time-report.service.js";

export function createTimeReportRoute(database: Database) {
  const router = createRouter();

  // GET /api/projects/:id/time-report?range=30d
  router.get("/:id/time-report", async (c) => {
    const range = parseRange(c.req.query("range"));
    return c.json(await computeTimeReport(c.req.param("id"), range, database));
  });

  return router;
}
