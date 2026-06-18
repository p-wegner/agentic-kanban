import type { Database } from "../db/index.js";
import { createRouter } from "../middleware/create-router.js";
import { parseJsonBody } from "../middleware/parse-body.js";
import { getDriveStatus, setDriveEnabled } from "../services/drive.service.js";
import { runDrivePreflight } from "../services/drive-preflight.service.js";

/**
 * One-switch "Drive this project" toggle (#806) + drive preflight gate (#807).
 * Mounted under `/projects`.
 *
 * - GET  /api/projects/:projectId/drive       — current Drive status + coherent breakdown.
 * - PUT  /api/projects/:projectId/drive {enabled} — flip the single switch, setting every
 *        owned preference coherently. Returns the resulting status.
 * - GET  /api/projects/:projectId/drive/preflight — assert hands-off prerequisites (read-only):
 *        a list of named checks + an overall `ready` verdict. Run this before a drive starts.
 * - POST /api/projects/:projectId/drive/preflight {autoRepair?} — same, but when `autoRepair`
 *        is true and every blocker is auto-fixable, flips Drive on to repair and re-evaluates.
 */
export function createDriveRoute(database: Database) {
  const router = createRouter();

  router.get("/:projectId/drive", async (c) => {
    return c.json(await getDriveStatus(c.req.param("projectId"), database));
  });

  router.get("/:projectId/drive/preflight", async (c) => {
    return c.json(await runDrivePreflight(c.req.param("projectId"), database));
  });

  router.post("/:projectId/drive/preflight", async (c) => {
    const body = await parseJsonBody<{ autoRepair?: boolean }>(c);
    return c.json(
      await runDrivePreflight(c.req.param("projectId"), database, { autoRepair: body.autoRepair === true }),
    );
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
