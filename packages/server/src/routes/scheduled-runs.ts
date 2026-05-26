import { Hono } from "hono";
import { db } from "../db/index.js";
import type { Database } from "../db/index.js";
import { createScheduledRunService, ScheduledRunError } from "../services/scheduled-run.service.js";

export function createScheduledRunsRoute(database: Database = db, serverPort?: number) {
  const router = new Hono();
  const service = createScheduledRunService({ database, serverPort });

  // GET /api/scheduled-runs?projectId=
  router.get("/", async (c) => {
    const projectId = c.req.query("projectId");
    if (!projectId) return c.json({ error: "projectId is required" }, 400);
    return c.json(await service.list(projectId));
  });

  // POST /api/scheduled-runs — create
  router.post("/", async (c) => {
    const body = await c.req.json();
    try {
      const created = await service.create(body);
      return c.json(created, 201);
    } catch (err) {
      if (err instanceof ScheduledRunError) {
        const code = err.code === "NOT_FOUND" ? 404 : 400;
        return c.json({ error: err.message }, code);
      }
      throw err;
    }
  });

  // PUT /api/scheduled-runs/:id — update
  router.put("/:id", async (c) => {
    const id = c.req.param("id");
    const body = await c.req.json();
    try {
      const updated = await service.update(id, body);
      return c.json(updated);
    } catch (err) {
      if (err instanceof ScheduledRunError) {
        const code = err.code === "NOT_FOUND" ? 404 : 400;
        return c.json({ error: err.message }, code);
      }
      throw err;
    }
  });

  // DELETE /api/scheduled-runs/:id
  router.delete("/:id", async (c) => {
    const id = c.req.param("id");
    try {
      await service.remove(id);
      return c.json({ ok: true });
    } catch (err) {
      if (err instanceof ScheduledRunError) {
        return c.json({ error: err.message }, 404);
      }
      throw err;
    }
  });

  // POST /api/scheduled-runs/:id/run — manual or scheduled trigger
  router.post("/:id/run", async (c) => {
    const id = c.req.param("id");
    try {
      const result = await service.run(id);
      return c.json({ ok: true, ...result });
    } catch (err) {
      if (err instanceof ScheduledRunError) {
        const code = err.code === "NOT_FOUND" ? 404 : 400;
        return c.json({ error: err.message }, code);
      }
      console.error("[scheduled-runs] run failed:", err);
      return c.json({ error: String(err) }, 500);
    }
  });

  return router;
}
