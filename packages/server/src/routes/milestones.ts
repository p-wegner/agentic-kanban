import type { Context } from "hono";
import { HTTPException } from "hono/http-exception";
import type { ZodType } from "zod";
import type { Database } from "../db/index.js";
import { createMilestoneService, MilestoneError } from "../services/milestone.service.js";
import { createRouter } from "../middleware/create-router.js";
import { parseJsonBody } from "../middleware/parse-body.js";
import { createMilestoneBody } from "./milestone-body-schemas.js";

import { queryInt } from "../middleware/query-params.js";
export function createMilestonesRoute(database: Database) {
  const router = createRouter();
  const service = createMilestoneService({ database });

  /**
   * `parseJsonBody(c, schema)` with this route file's ERROR IDENTITY preserved (#806, batch 4)
   * — the same wrapper `routes/plugins.ts` grew in batch 2, for the same reason.
   *
   * The guard this replaces threw `MilestoneError("name is required", "BAD_REQUEST")`, which
   * `domainErrorHandler` renders as `{ error, code: "BAD_REQUEST" }` at 400 (#823). A bare
   * schema swap throws `HTTPException`, whose body is `{ error }` alone, so it would have
   * silently dropped `code` from every rejection on this surface — a wire change, not a
   * hardening. Status and message are byte-identical either way; re-wrapping restores the
   * third field.
   *
   * The one knowing difference, inherited from `parsePluginBody`: an unparseable body
   * ("invalid JSON body", raised before the schema runs) now carries `code: "BAD_REQUEST"`
   * too. That is a field ADDED to a response that was already a 400 on a request that could
   * never have succeeded.
   */
  async function parseMilestoneBody<T>(c: Context, schema: ZodType<T>): Promise<T> {
    try {
      return await parseJsonBody(c, schema);
    } catch (err) {
      if (err instanceof HTTPException && err.status === 400) {
        throw new MilestoneError(err.message, "BAD_REQUEST");
      }
      throw err;
    }
  }

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
    const body = await parseMilestoneBody(c, createMilestoneBody);
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
