import type { Database } from "../db/index.js";
import type { SessionManager } from "../services/session.manager.js";
import type { BoardEvents } from "../services/board-events.js";
import { createShowdownService } from "../services/showdown.service.js";
import { createRouter } from "../middleware/create-router.js";
import { parseJsonBody } from "../middleware/parse-body.js";
import { WorkspaceError } from "../services/workspace-internals.js";

export function createShowdownsRoute(
  database: Database,
  getSessionManager?: () => SessionManager,
  options?: { boardEvents?: BoardEvents },
) {
  const router = createRouter();
  const showdownService = createShowdownService({
    database,
    getSessionManager,
    boardEvents: options?.boardEvents,
  });

  // GET /api/showdowns/:id
  router.get("/:id", async (c) => {
    const id = c.req.param("id");
    const result = await showdownService.getShowdown(id);
    if (!result) return c.json({ error: "Showdown not found" }, 404);
    return c.json(result);
  });

  // POST /api/showdowns/:id/pick-winner
  router.post("/:id/pick-winner", async (c) => {
    const id = c.req.param("id");
    const body = await parseJsonBody<{ winnerWorkspaceId: string }>(c);
    if (!body.winnerWorkspaceId) return c.json({ error: "winnerWorkspaceId is required" }, 400);
    try {
      const result = await showdownService.pickWinner(id, body.winnerWorkspaceId);
      return c.json(result);
    } catch (err) {
      if (err instanceof WorkspaceError) {
        return c.json({ error: err.message }, err.code === "NOT_FOUND" ? 404 : 400);
      }
      throw err;
    }
  });

  return router;
}
