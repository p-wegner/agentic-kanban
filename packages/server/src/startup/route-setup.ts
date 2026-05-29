import { serveStatic } from "@hono/node-server/serve-static";
import type { Hono } from "hono";
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
  upgradeWebSocket: (callback: (c: any) => any) => any;
}

export function setupRoutes(app: Hono, { sessionManager, boardEvents, reviewSessionIds, fixAndMergeSessionIds, db, upgradeWebSocket }: RouteSetupDeps) {
  app.post("/api/workspaces/:id/review", async (c) => {
    const workspaceId = c.req.param("id");
    try {
      const body = await c.req.json().catch(() => ({}));
      const thoroughReview = body.thoroughReview === true;
      const { sessionId } = await startManualReview(db, () => sessionManager, boardEvents, reviewSessionIds, workspaceId, thoroughReview);
      console.log(`[workflow] manual review session ${sessionId} for workspace ${workspaceId}`);
      return c.json({ sessionId });
    } catch (err) {
      if (err instanceof ReviewError) {
        if (err.code === "NOT_FOUND") return c.json({ error: err.message }, 404);
        if (err.code === "CONFLICT") return c.json({ error: err.message }, 409);
        if (err.code === "BAD_REQUEST") return c.json({ error: err.message }, 400);
      }
      console.error("[workflow] manual review trigger failed:", err);
      return c.json({ error: String(err) }, 500);
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
