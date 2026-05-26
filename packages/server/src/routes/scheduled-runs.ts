import { db } from "../db/index.js";
import type { Database } from "../db/index.js";
import { createScheduledRunService } from "../services/scheduled-run.service.js";
import { createRouter } from "../middleware/create-router.js";
import { parseJsonBody } from "../middleware/parse-body.js";

export function createScheduledRunsRoute(database: Database = db, serverPort?: number) {
  const router = createRouter();
  const service = createScheduledRunService({ database, serverPort });

  // GET /api/scheduled-runs?projectId=
  router.get("/", async (c) => {
    const projectId = c.req.query("projectId");
    if (!projectId) return c.json({ error: "projectId is required" }, 400);
    return c.json(await service.list(projectId));
  });

  // POST /api/scheduled-runs — create
  router.post("/", async (c) => {
    const body = await parseJsonBody(c);
    const created = await service.create(body);
    return c.json(created, 201);
  });

  // PUT /api/scheduled-runs/:id — update
  router.put("/:id", async (c) => {
    const id = c.req.param("id");
    const body = await parseJsonBody(c);
    const updated = await service.update(id, body);
    return c.json(updated);
  });

  // DELETE /api/scheduled-runs/:id
  router.delete("/:id", async (c) => {
    const id = c.req.param("id");
    await service.remove(id);
    return c.json({ ok: true });
  });

  // POST /api/scheduled-runs/:id/run — manual or scheduled trigger
  router.post("/:id/run", async (c) => {
    const id = c.req.param("id");
    const result = await service.run(id);
    return c.json({ ok: true, ...result });
  });

  return router;
}
