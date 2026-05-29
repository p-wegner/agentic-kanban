import { Hono } from "hono";
import { createProjectsRoute } from "./projects.js";
import { createIssuesRoute } from "./issues.js";
import { createWorkspacesRoute } from "./workspaces.js";
import { createWorkspaceActionsRoute } from "./workspace-actions.js";
import { createTagsRoute } from "./tags.js";
import { createPreferencesRoute } from "./preferences.js";
import { createAgentSkillsRoute } from "./agent-skills.js";
import { createApprovalsRoute } from "./approvals.js";
import { createScheduledRunsRoute } from "./scheduled-runs.js";
import { createButlerRoute } from "./butler.js";
import { createAgentQuestionsRoute } from "./agent-questions.js";
import { createWorkflowsRoute } from "./workflows.js";
import { createWorkflowForkService } from "../services/workflow-fork.service.js";
import type { Database } from "../db/index.js";
import type { SessionManager } from "../services/session.manager.js";
import type { BoardEvents, BoardEventType } from "../services/board-events.js";
import { createRouter } from "../middleware/create-router.js";
import { parseOptionalJsonBody } from "../middleware/parse-body.js";

interface RouteOptions {
  boardEvents?: BoardEvents;
  fixAndMergeSessionIds?: Set<string>;
  serverPort?: number;
}

export function createRoutes(database: Database, getSessionManager: () => SessionManager, options?: RouteOptions) {
  const routes = createRouter();

  // Parallel fork/join orchestrator (#82) — shared by the internal advance hook
  // and the REST manual-transition route.
  const forkService = createWorkflowForkService({
    database,
    getSessionManager,
    boardEvents: options?.boardEvents,
  });
  const onWorkflowAdvanced = (workspaceId: string) => forkService.onWorkspaceEnteredNode(workspaceId);

  routes.route("/projects", createProjectsRoute(database));
  routes.route("/projects", createButlerRoute(database, getSessionManager, options));
  routes.route("/projects", createAgentQuestionsRoute(database, getSessionManager, options));
  routes.route("/issues", createIssuesRoute(database, options));
  routes.route("/workspaces", createWorkspacesRoute(database, getSessionManager, options));
  routes.route("/workspaces", createWorkspaceActionsRoute(getSessionManager, database, options));
  routes.route("/tags", createTagsRoute(database));
  routes.route("/preferences", createPreferencesRoute(database));
  routes.route("/agent-skills", createAgentSkillsRoute(database));
  routes.route("/workflows", createWorkflowsRoute(database, { ...options, onWorkflowAdvanced }));
  routes.route("/scheduled-runs", createScheduledRunsRoute(database, getSessionManager, options?.boardEvents));
  if (options?.boardEvents) {
    routes.route("/approvals", createApprovalsRoute(options.boardEvents));
  }

  // Internal endpoint for MCP/CLI tools to trigger immediate board refresh
  routes.post("/internal/board-notify", async (c) => {
    if (!options?.boardEvents) {
      return c.json({ ok: true, note: "no boardEvents" }, 200);
    }
    const body = await parseOptionalJsonBody<{ projectId?: string; reason?: string }>(c);
    if (body.projectId) {
      options.boardEvents.broadcast(body.projectId, (body.reason ?? "internal_notify") as BoardEventType);
    }
    return c.json({ ok: true });
  });

  // Internal endpoint: a workflow transition happened (e.g. via the MCP
  // propose_transition tool in the separate MCP process). Run fork/join
  // orchestration in the main server, which owns the session manager + git.
  routes.post("/internal/workflow-advanced", async (c) => {
    const body = await parseOptionalJsonBody<{ workspaceId?: string }>(c);
    if (body.workspaceId) {
      // Fire-and-forget: orchestration can spawn/launch sessions and take time.
      forkService.onWorkspaceEnteredNode(body.workspaceId).catch(() => {});
    }
    return c.json({ ok: true });
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
