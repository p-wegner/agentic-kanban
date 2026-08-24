import type { Context } from "hono";
import { HTTPException } from "hono/http-exception";
import type { ZodType } from "zod";
import type { Database } from "../db/index.js";
import { createScheduledRunService, ScheduledRunError } from "../services/scheduled-run.service.js";
import { createWorkspaceService } from "../services/workspace.service.js";
import { createRouter } from "../middleware/create-router.js";
import { parseJsonBody } from "../middleware/parse-body.js";
import { createScheduledRunBody } from "./scheduled-run-body-schemas.js";
import type { BoardEventSink } from "../services/board-events.js";
import type { SessionManager } from "../services/session.manager.js";

export function createScheduledRunsRoute(
  database: Database,
  getSessionManager?: () => SessionManager,
  boardEvents?: BoardEventSink,
) {
  const router = createRouter();
  const workspaceService = createWorkspaceService({ database, getSessionManager, boardEvents });
  const service = createScheduledRunService({ database, createWorkspace: workspaceService.createWorkspace });

  /**
   * `parseJsonBody(c, schema)` with this route file's ERROR IDENTITY preserved (#806, batch 4),
   * the `parsePluginBody` pattern batch 2 established.
   *
   * `ScheduledRunError(msg, "BAD_REQUEST")` renders as `{ error, code: "BAD_REQUEST" }` at 400
   * (#823); an unwrapped schema throws `HTTPException`, whose body is `{ error }` alone, so the
   * swap would have dropped `code`. Knowing difference: "invalid JSON body" now carries it too.
   */
  async function parseScheduledRunBody<T>(c: Context, schema: ZodType<T>): Promise<T> {
    try {
      return await parseJsonBody(c, schema);
    } catch (err) {
      if (err instanceof HTTPException && err.status === 400) {
        throw new ScheduledRunError(err.message, "BAD_REQUEST");
      }
      throw err;
    }
  }

  // GET /api/scheduled-runs?projectId=
  router.get("/", async (c) => {
    const projectId = c.req.query("projectId");
    if (!projectId) return c.json({ error: "projectId is required" }, 400);
    return c.json(await service.list(projectId));
  });

  // POST /api/scheduled-runs — create
  router.post("/", async (c) => {
    const body = await parseScheduledRunBody(c, createScheduledRunBody);
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
    const result = await service.run(id, c.req.query("triggeredBy") ?? "manual");
    return c.json({ ok: true, ...result });
  });

  return router;
}
