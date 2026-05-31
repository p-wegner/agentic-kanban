import { db } from "../db/index.js";
import type { Database } from "../db/index.js";
import { createRouter } from "../middleware/create-router.js";
import { parseJsonBody } from "../middleware/parse-body.js";
import { createQualityMetricsService } from "../services/quality-metrics.service.js";
import type { CreateQualityMetricsRequest, QualityMetricsResponse } from "@agentic-kanban/shared/types";

export function createQualityMetricsRoute(database: Database = db) {
  const router = createRouter();
  const service = createQualityMetricsService(database);

  // GET /api/projects/:id/quality-metrics
  router.get("/:id/quality-metrics", async (c) => {
    const projectId = c.req.param("id");
    const metricKey = c.req.query("metricKey");
    const since = c.req.query("since");
    const result: QualityMetricsResponse = await service.list(projectId, { metricKey, since });
    return c.json(result);
  });

  // GET /api/projects/:id/quality-metrics/latest
  router.get("/:id/quality-metrics/latest", async (c) => {
    const projectId = c.req.param("id");
    const latest = await service.latest(projectId);
    return c.json({ latest, trend: [] } satisfies QualityMetricsResponse);
  });

  // POST /api/projects/:id/quality-metrics
  router.post("/:id/quality-metrics", async (c) => {
    const projectId = c.req.param("id");
    const body = await parseJsonBody<CreateQualityMetricsRequest>(c);
    const result = await service.recordBatch(projectId, body);
    return c.json(result, 201);
  });

  return router;
}
