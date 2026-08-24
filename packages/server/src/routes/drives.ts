import type { Context } from "hono";
import { HTTPException } from "hono/http-exception";
import type { ZodType } from "zod";
import type { Database } from "../db/index.js";
import { createDriveService, DriveError } from "../services/drive.service.js";
import { buildDriveDashboard } from "../services/drive-dashboard.service.js";
import { createRouter } from "../middleware/create-router.js";
import { parseJsonBody, parseOptionalJsonBody } from "../middleware/parse-body.js";
import { queryFlag } from "../middleware/query-params.js";
import { startDriveBody } from "./drive-body-schemas.js";
import {
  computeReviewEffectiveness,
  resolveDriveIssueIds,
} from "../services/review-effectiveness.service.js";

// DriveError is mapped to HTTP centrally by domainErrorHandler (createRouter applies
// it as onError) via its `code` field — NOT_FOUND→404, FORBIDDEN→403, BAD_REQUEST→400.
// Handlers just let it throw; no per-route try/catch or status mapping needed.
export function createDrivesRoute(database: Database) {
  const router = createRouter();
  const service = createDriveService({ database });

  /**
   * `parseJsonBody(c, schema)` with this route file's ERROR IDENTITY preserved (#806, batch 4),
   * the `parsePluginBody` pattern batch 2 established.
   *
   * Every guard on this surface throws `DriveError(msg, "BAD_REQUEST")`, which
   * `domainErrorHandler` renders as `{ error, code: "BAD_REQUEST" }` at 400 (#823); an
   * unwrapped schema throws `HTTPException`, whose body is `{ error }` alone. Re-wrapping keeps
   * the third field. Knowing difference: "invalid JSON body" now carries `code` too.
   *
   * Only `POST /:projectId/drives` uses it. `PUT /:projectId/drives/:id` reads an UNTYPED body
   * forwarded whole to `service.update`, whose `target cannot be empty` guard runs AFTER the
   * existence + ownership checks — so a schema would answer 400 where a caller gets 404/403
   * today. `POST /:id/finish` is a `parseOptionalJsonBody` site whose contract is that the body
   * may be absent. Both stay in #806's census.
   */
  async function parseDriveBody<T>(c: Context, schema: ZodType<T>): Promise<T> {
    try {
      return await parseJsonBody(c, schema);
    } catch (err) {
      if (err instanceof HTTPException && err.status === 400) {
        throw new DriveError(err.message, "BAD_REQUEST");
      }
      throw err;
    }
  }

  // GET /api/projects/:projectId/drives
  router.get("/:projectId/drives", async (c) => {
    return c.json(await service.list(c.req.param("projectId")));
  });

  // GET /api/projects/:projectId/drives/:id
  router.get("/:projectId/drives/:id", async (c) => {
    return c.json(await service.get(c.req.param("projectId"), c.req.param("id")));
  });

  // GET /api/projects/:projectId/drives/:id/review-effectiveness
  // Per-drive AI code-review effectiveness: reviews run, reviews that bounced a
  // ticket back to building, and merged-without-review — scoped to the drive's
  // time window and (unless ?wholeProject=true) the meta-issue's dependency subtree.
  router.get("/:projectId/drives/:id/review-effectiveness", async (c) => {
    const projectId = c.req.param("projectId");
    const drive = await service.get(projectId, c.req.param("id"));
    const wholeProject = queryFlag(c, "wholeProject");
    const deep = queryFlag(c, "deep");

    const issueIds = wholeProject
      ? null
      : await resolveDriveIssueIds(drive.metaIssueId, drive.projectId, database);

    const report = await computeReviewEffectiveness(
      { projectId: drive.projectId, sinceIso: drive.startedAt, untilIso: drive.finishedAt ?? null, issueIds, deep },
      database,
    );

    return c.json({
      drive: {
        id: drive.id,
        target: drive.target,
        status: drive.status,
        metaIssueId: drive.metaIssueId,
        startedAt: drive.startedAt,
        finishedAt: drive.finishedAt,
        scope: wholeProject ? "whole-project" : drive.metaIssueId ? "meta-issue-subtree" : "whole-project-in-window",
      },
      ...report,
    });
  });

  // GET /api/projects/:projectId/drives/:id/dashboard — aggregated drive view (#800)
  router.get("/:projectId/drives/:id/dashboard", async (c) => {
    const dashboard = await buildDriveDashboard(
      database,
      c.req.param("projectId"),
      c.req.param("id"),
    );
    return c.json(dashboard);
  });

  // POST /api/projects/:projectId/drives  — starts a drive
  router.post("/:projectId/drives", async (c) => {
    const body = await parseDriveBody(c, startDriveBody);
    const result = await service.start(c.req.param("projectId"), body);
    return c.json(result, 201);
  });

  // PUT /api/projects/:projectId/drives/:id
  router.put("/:projectId/drives/:id", async (c) => {
    const body = await parseJsonBody(c);
    const result = await service.update(c.req.param("projectId"), c.req.param("id"), body);
    return c.json(result);
  });

  // POST /api/projects/:projectId/drives/:id/finish
  router.post("/:projectId/drives/:id/finish", async (c) => {
    const body = await parseOptionalJsonBody<{ status?: "completed" | "abandoned" }>(c);
    const result = await service.finish(c.req.param("projectId"), c.req.param("id"), body.status);
    return c.json(result);
  });

  // DELETE /api/projects/:projectId/drives/:id
  router.delete("/:projectId/drives/:id", async (c) => {
    await service.remove(c.req.param("projectId"), c.req.param("id"));
    return c.json({ success: true });
  });

  return router;
}
