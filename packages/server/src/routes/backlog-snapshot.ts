import type { Database } from "../db/index.js";
import type { BoardEvents } from "../services/board-events.js";
import { createRouter } from "../middleware/create-router.js";
import { getProjectById } from "../repositories/project.repository.js";
import {
  exportBacklogSnapshot,
  importBacklogSnapshot,
  validateBacklogSnapshot,
} from "../services/backlog-snapshot.service.js";

/**
 * Lossless, device-portable backlog snapshot export/import (distinct from the
 * flat CSV/JSON issue importer in issue-export-import.ts): preserves status
 * placement, issue numbers, tags, milestones, checklists and dependencies.
 */
export function createBacklogSnapshotRoute(
  database: Database,
  options?: { boardEvents?: BoardEvents },
) {
  const router = createRouter();

  // GET /api/projects/:projectId/backlog/export → downloadable JSON snapshot.
  router.get("/:projectId/backlog/export", async (c) => {
    const projectId = c.req.param("projectId");
    const project = await getProjectById(projectId, database);
    if (!project) return c.json({ error: "Project not found" }, 404);

    const snapshot = await exportBacklogSnapshot(projectId, database);
    const safeName = project.name.replace(/[^\w.-]+/g, "-").replace(/^-+|-+$/g, "") || "backlog";
    return new Response(JSON.stringify(snapshot, null, 2), {
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Content-Disposition": `attachment; filename="${safeName}-backlog.json"`,
      },
    });
  });

  // POST /api/projects/:projectId/backlog/import
  // Accepts a multipart "file" upload OR an application/json body that is either
  // the snapshot object itself or { snapshot }. Returns the import result summary.
  router.post("/:projectId/backlog/import", async (c) => {
    const projectId = c.req.param("projectId");
    const project = await getProjectById(projectId, database);
    if (!project) return c.json({ error: "Project not found" }, 404);

    const contentType = c.req.header("content-type") ?? "";
    let raw: unknown;

    if (contentType.includes("multipart/form-data")) {
      const formData = await c.req.formData();
      const file = formData.get("file");
      if (!file || typeof file === "string") {
        return c.json({ error: "multipart upload must include a 'file' field" }, 400);
      }
      try {
        raw = JSON.parse(await file.text());
      } catch {
        return c.json({ error: "Uploaded file is not valid JSON" }, 400);
      }
    } else if (contentType.includes("application/json")) {
      const body: unknown = await c.req.json().catch(() => null);
      const obj = body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : null;
      raw = obj && "snapshot" in obj ? obj.snapshot : body;
    } else {
      return c.json({ error: "Content-Type must be application/json or multipart/form-data" }, 400);
    }

    const { snapshot, errors } = validateBacklogSnapshot(raw);
    if (!snapshot) {
      return c.json({ error: "Invalid backlog snapshot", errors }, 400);
    }

    const result = await importBacklogSnapshot(projectId, snapshot, database);
    options?.boardEvents?.broadcast(projectId, "internal_notify");
    return c.json(result, 201);
  });

  return router;
}
