import type { Database } from "../db/index.js";
import { createDriveService } from "../services/drive.service.js";
import { buildDriveDashboard } from "../services/drive-dashboard.service.js";
import { createRouter } from "../middleware/create-router.js";
import { parseJsonBody, parseOptionalJsonBody } from "../middleware/parse-body.js";
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
    const wholeProject = c.req.query("wholeProject") === "true";
    const deep = c.req.query("deep") === "true";

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
    const body = await parseJsonBody(c);
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
