import type { Database } from "../db/index.js";
import { createMilestoneService } from "../services/milestone.service.js";
import { createRouter } from "../middleware/create-router.js";
import { parseJsonBody } from "../middleware/parse-body.js";

import { queryInt } from "../middleware/query-params.js";
export function createMilestonesRoute(database: Database) {
  const router = createRouter();
  const service = createMilestoneService({ database });

  // GET /api/projects/:projectId/milestones
  router.get("/:projectId/milestones", async (c) => {
    return c.json(await service.list(c.req.param("projectId")));
  });

  // GET /api/projects/:projectId/milestones/summary
  router.get("/:projectId/milestones/summary", async (c) => {
    // #511: was `parseInt(...)` with no finiteness check, so `?days=abc` passed NaN
    // straight into the service. `min: 1` because a non-positive window is meaningless.
    const days = queryInt(c, "days", { def: 30, min: 1 });
    return c.json(await service.summary(c.req.param("projectId"), days));
  });

  // POST /api/projects/:projectId/milestones
  router.post("/:projectId/milestones", async (c) => {
    const body = await parseJsonBody<{ name: string; dueDate?: string | null }>(c);
    const result = await service.create(c.req.param("projectId"), body);
    return c.json(result, 201);
  });

  // PUT /api/projects/:projectId/milestones/:id
  router.put("/:projectId/milestones/:id", async (c) => {
    const body = await parseJsonBody<{ name?: string; dueDate?: string | null }>(c);
    const result = await service.update(c.req.param("projectId"), c.req.param("id"), body);
    return c.json(result);
  });

  // DELETE /api/projects/:projectId/milestones/:id
  router.delete("/:projectId/milestones/:id", async (c) => {
    await service.remove(c.req.param("projectId"), c.req.param("id"));
    return c.json({ success: true });
  });

  return router;
}
