import type { Database } from "../db/index.js";
import type { SessionManager } from "../services/session.manager.js";
import type { BoardEventSink } from "../services/board-events.js";
import { createRouter } from "../middleware/create-router.js";
import { parseJsonBody } from "../middleware/parse-body.js";
import { queueFlushBody } from "./project-queue-flush-body-schemas.js";
import { createMergeQueueService } from "../services/merge-queue.service.js";
import { createQueueFlushService, type QueueFlushDeps } from "../services/queue-flush.service.js";

/**
 * The queue flush action (#1463, decision 020): the one door the delivery view's Flush button and
 * `pnpm cli -- queue flush` both go through. Rails (`queue_flush_<id>`, posture rung, daily cap,
 * promotion sweep in flight, supersede) are `checkQueueFlushRails`' — a refusal is a 409 carrying
 * the reason and the plan, never a half-run flush.
 *
 *  - `dryRun: true`  -> 200 `{ ok, dryRun, plan }` — what WOULD flush, or why it would not.
 *  - otherwise       -> starts ONE flush-mode train over every ready branch and answers 202 at once
 *    (`wait: true` answers when it has finished: the landing tag, record and outcome). Progress is
 *    `GET /:id/flushes` and the delivery chip.
 */
export function createProjectQueueFlushRoute(
  database: Database,
  getSessionManager: () => SessionManager,
  options?: {
    boardEvents?: BoardEventSink;
    /** Test seams: the on-demand sweep and the stable-checkout location. */
    flushDeps?: Pick<Partial<QueueFlushDeps>, "requestSweep" | "stableCheckoutFor">;
  },
) {
  const router = createRouter();
  const queueService = createMergeQueueService({ database, boardEvents: options?.boardEvents, getSessionManager });
  const flushService = createQueueFlushService({
    database,
    executeQueue: (workspaceIds, opts) => queueService.executeQueue(workspaceIds, opts),
    ...options?.flushDeps,
  });

  router.post("/:id/queue/flush", async (c) => {
    const projectId = c.req.param("id");
    const body = await parseJsonBody(c, queueFlushBody);
    const started = await flushService.start(projectId, { triggeredBy: body.triggeredBy ?? "manual", dryRun: body.dryRun === true });
    if (started.refused) return c.json({ ok: false, error: started.refused, refused: started.refused, plan: started.plan }, 409);
    if (started.dryRun) return c.json({ ok: true, dryRun: true, plan: started.plan });
    // `wait: true` blocks until the train has finished (tests, scripts with a long client timeout).
    if (body.wait === true && started.done) return c.json({ ...(await started.done) });
    return c.json({ ok: true, started: true, plan: started.plan }, 202);
  });

  return router;
}
