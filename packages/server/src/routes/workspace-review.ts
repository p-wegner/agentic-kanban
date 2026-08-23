import type { Database } from "../db/index.js";
import type { BoardEventSink } from "../services/board-events.js";
import type { SessionManager } from "../services/session.manager.js";
import { createRouter } from "../middleware/create-router.js";
import { parseOptionalJsonBody } from "../middleware/parse-body.js";
import { domainErrorHandler } from "../middleware/error-handler.js";
import { ReviewError, startManualReview } from "../services/review.service.js";

/**
 * `POST /api/workspaces/:id/review` — trigger a manual review session for one workspace.
 *
 * #805: this handler used to be DEFINED inline in `startup/route-setup.ts`, the last
 * survivor of the "no route definitions in `startup/`" rule (see
 * `packages/server/CLAUDE.md`). That was not only an architecture wart: the OpenAPI
 * generator scans `src/routes/`, so the single busiest workflow endpoint the UI and the
 * CLI call was absent from `openapi.yaml` while the generator printed an `unresolved`
 * list that implied full coverage. Moving the definition here makes the generator right
 * without teaching it about the exception.
 *
 * It is still MOUNTED from `route-setup.ts` (mounting is the composition root's job) at
 * `/api/workspaces`, ahead of `app.route("/api", createRoutes(...))`, so resolution order
 * is exactly what it was before the move.
 */
export function createWorkspaceReviewRoute(
  database: Database,
  getSessionManager: () => SessionManager,
  deps: { boardEvents: BoardEventSink; reviewSessionIds: Set<string> },
) {
  const router = createRouter();

  // Trigger a manual review session for a workspace.
  router.post("/:id/review", async (c) => {
    const workspaceId = c.req.param("id");
    try {
      const body = await parseOptionalJsonBody<{ thoroughReview?: boolean }>(c);
      const thoroughReview = body.thoroughReview === true;
      const { sessionId } = await startManualReview(
        database,
        getSessionManager,
        deps.boardEvents,
        deps.reviewSessionIds,
        workspaceId,
        thoroughReview,
      );
      console.log(`[workflow] manual review session ${sessionId} for workspace ${workspaceId}`);
      return c.json({ sessionId });
    } catch (err) {
      if (err instanceof ReviewError) {
        if (err.code === "NOT_FOUND") return c.json({ error: err.message, code: err.code }, 404);
        if (err.code === "CONFLICT") {
          const body: Record<string, unknown> = { error: err.message, code: err.code };
          if (err.details?.workspaceStatus) body.workspaceStatus = err.details.workspaceStatus;
          if (err.details?.retryable !== undefined) body.retryable = err.details.retryable;
          if (err.details?.reason) body.reason = err.details.reason;
          if (err.details?.activeSessionId) body.activeSessionId = err.details.activeSessionId;
          if (err.details?.activeTriggerType !== undefined) body.activeTriggerType = err.details.activeTriggerType;
          if (err.details?.latestSessionId) body.latestSessionId = err.details.latestSessionId;
          if (err.details?.latestTriggerType !== undefined) body.latestTriggerType = err.details.latestTriggerType;
          if (err.details?.conflictFiles?.length) body.conflictFiles = err.details.conflictFiles;
          if (err.details?.uncommittedChanges?.length) body.uncommittedChanges = err.details.uncommittedChanges;
          return c.json(body, 409);
        }
        if (err.code === "BAD_REQUEST") return c.json({ error: err.message, code: err.code }, 400);
      }
      console.error("[workflow] manual review trigger failed:", err);
      // #683 — everything that is not a ReviewError must reach the ONE mapper rather than
      // this handler's own catch-all: `startManualReview` rethrows `startSession`'s errors
      // unchanged, so a stale safety policy lost its 409 AND its `staleFiles` payload
      // (which the UI and monitor branch on), and strict worker dispatch with no live
      // worker reported an internal error rather than 503.
      //
      // `createRouter()` installs `domainErrorHandler` as this router's `onError`, so a
      // THROW would also be mapped correctly now that the handler lives here. The explicit
      // delegation stays anyway: it keeps the mapping visible at the call site and is
      // identical in effect. The ReviewError branch above stays too — it carries a
      // request-shaped payload (activeSessionId, latestTriggerType, …) that is this
      // endpoint's own contract, not a domain-error concern.
      if (err instanceof Error) return domainErrorHandler(err, c);
      return c.json({ error: String(err), code: "INTERNAL" }, 500);
    }
  });

  return router;
}
