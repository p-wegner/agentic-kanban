import { Hono } from "hono";
import { createProjectsRoute, projectsRoute } from "./projects.js";
import { createIssuesRoute, issuesRoute } from "./issues.js";
import { createWorkspacesRoute, workspacesRoute } from "./workspaces.js";
import { createWorkspaceActionsRoute } from "./workspace-actions.js";
import { createTagsRoute, tagsRoute } from "./tags.js";
import { createPreferencesRoute, preferencesRoute } from "./preferences.js";
import type { Database } from "../db/index.js";
import type { SessionManager } from "../services/session.manager.js";
import type { BoardEvents } from "../services/board-events.js";

interface RouteOptions {
  boardEvents?: BoardEvents;
}

export function createRoutes(database: Database, getSessionManager: () => SessionManager, options?: RouteOptions) {
  const routes = new Hono();
  routes.route("/projects", createProjectsRoute(database));
  routes.route("/issues", createIssuesRoute(database, options));
  routes.route("/workspaces", createWorkspacesRoute(database));
  routes.route("/workspaces", createWorkspaceActionsRoute(getSessionManager, database, options));
  routes.route("/tags", createTagsRoute());
  routes.route("/preferences", createPreferencesRoute(database));

  // Internal endpoint for MCP/CLI tools to trigger immediate board refresh
  routes.post("/internal/board-notify", async (c) => {
    if (!options?.boardEvents) {
      return c.json({ ok: true, note: "no boardEvents" }, 200);
    }
    try {
      const body = await c.req.json<{ projectId?: string; reason?: string }>();
      if (body.projectId) {
        options.boardEvents.broadcast(body.projectId, body.reason ?? "internal_notify");
      }
      return c.json({ ok: true });
    } catch {
      return c.json({ ok: true, note: "invalid body" }, 200);
    }
  });

  return routes;
}

// Lazy getter for the default session manager (avoids circular imports at module load)
let _sessionManager: SessionManager | null = null;
function getDefaultSessionManager(): SessionManager {
  if (!_sessionManager) {
    // Dynamic import to avoid circular dependency at module load time
    throw new Error("Session manager not initialized. Server must be started first.");
  }
  return _sessionManager;
}

export function setSessionManager(sm: SessionManager) {
  _sessionManager = sm;
}

export const routes = new Hono();
routes.route("/projects", projectsRoute);
routes.route("/issues", issuesRoute);
routes.route("/workspaces", workspacesRoute);
routes.route("/tags", tagsRoute);
routes.route("/preferences", preferencesRoute);
// Note: workspace-actions route is mounted separately in index.ts to avoid circular imports
