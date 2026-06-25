import { serveStatic } from "@hono/node-server/serve-static";
import type { Hono } from "hono";
import type { UpgradeWebSocket } from "hono/ws";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Database } from "../db/index.js";
import { createBoardWsRoute } from "../routes/board-ws.js";
import { createRoutes } from "../routes/index.js";
import { createSessionsRoute } from "../routes/sessions.js";
import type { createBoardEvents } from "../services/board-events.js";
import { ReviewError, startManualReview } from "../services/review.service.js";
import { createSessionManager } from "../services/session.manager.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

export interface RouteSetupDeps {
  sessionManager: ReturnType<typeof createSessionManager>;
  boardEvents: ReturnType<typeof createBoardEvents>;
  reviewSessionIds: Set<string>;
  fixAndMergeSessionIds: Set<string>;
  db: Database;
  upgradeWebSocket: UpgradeWebSocket;
}

export function setupRoutes(app: Hono, { sessionManager, boardEvents, reviewSessionIds, fixAndMergeSessionIds, db, upgradeWebSocket }: RouteSetupDeps) {
  app.post("/api/workspaces/:id/review", async (c) => {
    const workspaceId = c.req.param("id");
    try {
      const body = await c.req.json<{ thoroughReview?: boolean }>().catch(() => ({}) as { thoroughReview?: boolean });
      const thoroughReview = body.thoroughReview === true;
      const { sessionId } = await startManualReview(db, () => sessionManager, boardEvents, reviewSessionIds, workspaceId, thoroughReview);
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
      return c.json({ error: String(err), code: "INTERNAL" }, 500);
    }
  });

  app.get("/ws/sessions/:sessionId", sessionManager.wsRoute());
  app.get("/ws/board/:projectId", createBoardWsRoute(upgradeWebSocket, boardEvents));
  app.route("/api", createRoutes(db, () => sessionManager, { boardEvents, fixAndMergeSessionIds }));
  app.route("/api/sessions", createSessionsRoute(db));

  const clientDir = resolve(__dirname, "../client");
  if (existsSync(resolve(clientDir, "index.html"))) {
    app.use("/*", serveStatic({ root: clientDir }));
    app.get("*", serveStatic({ root: clientDir, path: "index.html" }));
  }
}
