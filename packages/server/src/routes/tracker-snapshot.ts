import type { Database } from "../db/index.js";
import { createRouter } from "../middleware/create-router.js";
import { getProjectById } from "../repositories/project.repository.js";
import { buildTrackerSnapshot } from "../services/tracker-snapshot.service.js";

/**
 * GET /api/projects/:id/tracker-snapshot (#1140) — a compact, poll-friendly board
 * summary for a terminal tracker: column counts, WIP limit + active builders, in-flight
 * workspaces, blocked/stalled items with a reason, review queue depth, and base-branch
 * health. Read-only; reuses the same resolvers/queries the board itself uses rather than
 * re-deriving state, so it stays cheap enough to poll every few seconds.
 */
export function createTrackerSnapshotRoute(database: Database) {
  const router = createRouter();

  router.get("/:id/tracker-snapshot", async (c) => {
    const projectId = c.req.param("id");
    const project = await getProjectById(projectId, database);
    if (!project) return c.json({ error: "not found" }, 404);

    const snapshot = await buildTrackerSnapshot(projectId, database);
    return c.json(snapshot);
  });

  return router;
}
