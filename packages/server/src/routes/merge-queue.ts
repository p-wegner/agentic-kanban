import { streamSSE } from "hono/streaming";
import { createRouter } from "../middleware/create-router.js";
import { parseJsonBody } from "../middleware/parse-body.js";
import { createMergeQueueService } from "../services/merge-queue.service.js";
import type { Database } from "../db/index.js";
import type { BoardEvents } from "../services/board-events.js";
import type { SessionManager } from "../services/session.manager.js";

export function createMergeQueueRoute(
  database: Database,
  getSessionManager: () => SessionManager,
  options?: { boardEvents?: BoardEvents },
) {
  const router = createRouter();

  const queueService = createMergeQueueService({
    database,
    boardEvents: options?.boardEvents,
    getSessionManager,
  });

  /**
   * POST /api/merge-queue
   *
   * body: { workspaceIds: string[], dryRun?: boolean, skipOnConflict?: boolean }
   *
   * - dryRun: true  → returns JSON plan (sorted order + conflict matrix)
   * - dryRun: false → streams SSE events while executing the queue
   */
  router.post("/", async (c) => {
    const body = await parseJsonBody<{
      workspaceIds?: string[];
      dryRun?: boolean;
      skipOnConflict?: boolean;
    }>(c);

    if (!Array.isArray(body.workspaceIds) || body.workspaceIds.length === 0) {
      return c.json({ error: "workspaceIds is required and must be a non-empty array" }, 400);
    }

    if (body.dryRun) {
      const plan = await queueService.computePlan(body.workspaceIds);
      return c.json({ ok: true, dryRun: true, plan });
    }

    // Execute the queue and stream SSE events
    return streamSSE(c, async (stream) => {
      try {
        for await (const event of queueService.executeQueue(body.workspaceIds!, {
          skipOnConflict: body.skipOnConflict ?? false,
        })) {
          await stream.writeSSE({ data: JSON.stringify(event) });
          if (event.type === "done") break;
          if (stream.closed) break;
        }
      } catch (err) {
        try {
          await stream.writeSSE({
            data: JSON.stringify({
              type: "error",
              workspaceId: "",
              issueNumber: null,
              issueTitle: "",
              error: err instanceof Error ? err.message : String(err),
            }),
          });
          await stream.writeSSE({
            data: JSON.stringify({ type: "done", merged: [], failed: [], skipped: [] }),
          });
        } catch {
          // stream already closed
        }
      }
    });
  });

  return router;
}
