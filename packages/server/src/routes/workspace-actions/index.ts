import { Hono } from "hono";
import { db } from "../../db/index.js";
import type { SessionManager } from "../../services/session.manager.js";
import type { BoardEvents } from "../../services/board-events.js";
import type { Database } from "../../db/index.js";
import { createSetupRoutes } from "./setup.js";
import { createSessionRoutes } from "./sessions.js";
import { createGitRoutes } from "./git.js";
import { createMergeRoutes } from "./merge.js";
import { createConflictRoutes } from "./conflicts.js";
import { createCommentRoutes } from "./comments.js";
import { createEditorRoutes } from "./editor.js";

export function createWorkspaceActionsRoute(
  getSessionManager: () => SessionManager,
  database: Database = db,
  options?: { boardEvents?: BoardEvents; fixAndMergeSessionIds?: Set<string> },
) {
  const router = new Hono();
  router.route("/", createSetupRoutes(database, options));
  router.route("/", createSessionRoutes(getSessionManager, database, options));
  router.route("/", createGitRoutes(database));
  router.route("/", createMergeRoutes(getSessionManager, database, options));
  router.route("/", createConflictRoutes(getSessionManager, database, options));
  router.route("/", createCommentRoutes(database));
  router.route("/", createEditorRoutes(database));
  return router;
}
