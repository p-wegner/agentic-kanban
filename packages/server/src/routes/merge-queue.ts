import { streamSSE } from "hono/streaming";
import { createRouter } from "../middleware/create-router.js";
import { parseJsonBody } from "../middleware/parse-body.js";
import { mergeQueueBody } from "./merge-queue-body-schemas.js";
import { createMergeQueueService } from "../services/merge-queue.service.js";
import type { Database } from "../db/index.js";
import type { BoardEventSink } from "../services/board-events.js";
import type { SessionLauncher } from "../services/session.manager.js";
import { errorMessage } from "@agentic-kanban/shared/lib/error-message";
import { getMergeTrain, listMergeTrainsForProject, updateMergeTrainState } from "../repositories/merge-train.repository.js";

export function createMergeQueueRoute(
  database: Database,
  getSessionManager: () => SessionLauncher,
  options?: { boardEvents?: BoardEventSink },
) {
  const router = createRouter();

  const queueService = createMergeQueueService({
    database,
    boardEvents: options?.boardEvents,
    getSessionManager,
  });

  /**
   * POST /api/merge-queue/preview/:workspaceId
   *
   * Dry-run conflict preview for a single workspace. Read-only — does not mutate the worktree.
   * Returns: WorkspaceConflictPreview
   */
  router.post("/preview/:workspaceId", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    try {
      const plan = await queueService.computePlan([workspaceId]);
      const preview = plan.conflictPreviews[0] ?? { workspaceId, hasConflicts: false, conflictingFiles: [], isStale: false };
      return c.json({ ok: true, preview });
    } catch (err) {
      return c.json({ ok: false, error: errorMessage(err) }, 500);
    }
  });

  /**
   * POST /api/merge-queue
   *
   * body: { workspaceIds: string[], dryRun?: boolean, skipOnConflict?: boolean, strategy?: "sequential" | "train" }
   *
   * - dryRun: true  → returns JSON plan (sorted order + conflict matrix + per-workspace conflictPreviews)
   * - dryRun: false → streams SSE events while executing the queue
   * - strategy: explicit override; "sequential" always wins, "train" opts in regardless of
   *   project defaults. Omitted → `executeQueue` decides (classifier recommendation or the
   *   project's `train_max_size` opt-in, #904).
   */
  router.post("/", async (c) => {
    const body = await parseJsonBody(c, mergeQueueBody);

    if (body.dryRun) {
      const plan = await queueService.computePlan(body.workspaceIds);
      return c.json({ ok: true, dryRun: true, plan });
    }

    // Execute the queue and stream SSE events
    return streamSSE(c, async (stream) => {
      try {
        for await (const event of queueService.executeQueue(body.workspaceIds, {
          skipOnConflict: body.skipOnConflict ?? false,
          strategy: body.strategy,
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
              error: errorMessage(err),
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

  /**
   * GET /api/merge-queue/trains?projectId=
   *
   * History of persisted release trains for a project (#906) — newest first, including
   * `abandoned` rows the startup reconciler left behind. What a "Merge train" panel reads.
   */
  router.get("/trains", async (c) => {
    const projectId = c.req.query("projectId");
    if (!projectId) {
      return c.json({ ok: false, error: "projectId query parameter is required" }, 400);
    }
    const trains = await listMergeTrainsForProject(projectId, database);
    return c.json({ ok: true, trains });
  });

  /**
   * POST /api/merge-queue/trains/:id/cancel
   *
   * #1153 — the only remedy an operator had for a stranded train was a full server restart
   * (the reconciler resumes an `assembling`/`gating` row otherwise). Marks the row `abandoned`
   * with a reason; the in-flight run (if the process holding it is still alive) is not
   * interrupted — there is no cancellation token for it — but `finishMergeTrain` checks for
   * `abandoned` before overwriting it, and no NEW train will be assembled for this project while
   * one is in an unfinished state, so cancelling is what unblocks that.
   */
  router.post("/trains/:id/cancel", async (c) => {
    const id = c.req.param("id");
    const train = await getMergeTrain(id, database);
    if (!train) {
      return c.json({ ok: false, error: "train not found" }, 404);
    }
    if (train.state !== "assembling" && train.state !== "gating") {
      return c.json({ ok: false, error: `train is already terminal (${train.state})` }, 409);
    }
    await updateMergeTrainState(id, {
      state: "abandoned",
      reconciledReason: "cancelled by operator",
      finishedAt: new Date().toISOString(),
    }, database);
    return c.json({ ok: true });
  });

  return router;
}
