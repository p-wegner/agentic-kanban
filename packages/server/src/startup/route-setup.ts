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
import { createWorkspaceReviewRoute } from "../routes/workspace-review.js";
import type { createBoardEvents } from "../services/board-events.js";
import { createSessionManager } from "../services/session.manager.js";
import { createWorkerWsRoute } from "../services/worker-connection.service.js";
import { getWorkerFleet } from "../services/worker-fleet.service.js";
import type { createWorkflowForkService } from "../services/workflow-fork.service.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

export interface RouteSetupDeps {
  sessionManager: ReturnType<typeof createSessionManager>;
  boardEvents: ReturnType<typeof createBoardEvents>;
  reviewSessionIds: Set<string>;
  fixAndMergeSessionIds: Set<string>;
  db: Database;
  upgradeWebSocket: UpgradeWebSocket;
  /** Shared with the session-exit workflow — see `RouteOptions.forkService`. */
  forkService?: ReturnType<typeof createWorkflowForkService>;
}

export function setupRoutes(app: Hono, { sessionManager, boardEvents, reviewSessionIds, fixAndMergeSessionIds, db, upgradeWebSocket, forkService }: RouteSetupDeps) {
  // #805 — the review endpoint's DEFINITION now lives in `routes/workspace-review.ts`,
  // where `scripts/generate-openapi.ts` can see it; this file only MOUNTS it, which is the
  // composition root's job. Registered ahead of `app.route("/api", createRoutes(...))`, as
  // the inline handler was, so Hono's resolution order is unchanged.
  app.route("/api/workspaces", createWorkspaceReviewRoute(db, () => sessionManager, { boardEvents, reviewSessionIds }));

  app.get("/ws/sessions/:sessionId", sessionManager.wsRoute());
  app.get("/ws/board/:projectId", createBoardWsRoute(upgradeWebSocket, boardEvents));
  // Fleet worker sockets (epic #1): token-authed upgrade; the fleet bundle is
  // shared with /api/workers and the session lifecycle's remote dispatch.
  const workerFleet = getWorkerFleet(db);
  app.get("/ws/workers/:id", createWorkerWsRoute(upgradeWebSocket, workerFleet.registry, workerFleet.connections));
  app.route("/api", createRoutes(db, () => sessionManager, { boardEvents, fixAndMergeSessionIds, forkService }));
  app.route("/api/sessions", createSessionsRoute(db));

  const clientDir = resolve(__dirname, "../client");
  if (existsSync(resolve(clientDir, "index.html"))) {
    app.use("/*", serveStatic({ root: clientDir }));
    app.get("*", serveStatic({ root: clientDir, path: "index.html" }));
  }
}
