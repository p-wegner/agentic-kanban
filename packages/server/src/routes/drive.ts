import { db } from "../db/index.js";
import type { Database } from "../db/index.js";
import { createRouter } from "../middleware/create-router.js";
import { parseJsonBody } from "../middleware/parse-body.js";
import { getDriveStatus, setDriveEnabled } from "../services/drive.service.js";

/**
 * One-switch "Drive this project" toggle (#806). Mounted under `/projects`.
 *
 * - GET  /api/projects/:projectId/drive       — current Drive status + coherent breakdown.
 * - PUT  /api/projects/:projectId/drive {enabled} — flip the single switch, setting every
 *        owned preference coherently. Returns the resulting status.
 */
export function createDriveRoute(database: Database = db) {
  const router = createRouter();

  router.get("/:projectId/drive", async (c) => {
    return c.json(await getDriveStatus(c.req.param("projectId"), database));
  });

  router.put("/:projectId/drive", async (c) => {
    const body = await parseJsonBody<{ enabled?: boolean }>(c);
    if (typeof body.enabled !== "boolean") {
      return c.json({ error: "enabled (boolean) is required" }, 400);
    }
    return c.json(await setDriveEnabled(c.req.param("projectId"), body.enabled, database));
  });

  return router;
}
