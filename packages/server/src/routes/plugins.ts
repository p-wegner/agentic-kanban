import type { Context } from "hono";
import type { Database } from "../db/index.js";
import type { SessionManager } from "../services/session.manager.js";
import type { BoardEvents } from "../services/board-events.js";
import { createRouter } from "../middleware/create-router.js";
import { parseJsonBody, parseOptionalJsonBody } from "../middleware/parse-body.js";
import { getPluginService, PluginError } from "../services/plugin.service.js";
import { createIssueService } from "../services/issue.service.js";
import { createWorkspaceService } from "../services/workspace.service.js";
import { createWebhookSender } from "../services/outbound-webhook.service.js";

/**
 * Plugin-system REST surface, mounted at `/plugins` (routes/index.ts):
 *
 *   GET    /api/plugins?projectId=            list (manifest + enabled flag when projectId given)
 *   POST   /api/plugins { source }            install (local dir or git URL)
 *   DELETE /api/plugins/:id                   remove row + disable (files kept)
 *   POST   /api/plugins/:id/enable  { projectId }
 *   POST   /api/plugins/:id/disable { projectId }
 *   GET    /api/plugins/:id/views?projectId=  view descriptors + running state + url
 *   POST   /api/plugins/:id/views/:viewId/start { projectId } → { url, port, pid }
 *   POST   /api/plugins/:id/views/:viewId/stop  { projectId }
 *   POST   /api/plugins/:id/scripts/:name/run   { projectId } → { code, stdout, stderr, timedOut }
 *   POST   /api/plugins/:id/skills/:name/run    { projectId, title?, description? } →
 *            { issueId, issueNumber, workspaceId, branch } (creates a ticket + launches a
 *            workspace against the skill — the agentic counterpart to scripts/:name/run)
 *   GET    /api/plugins/:id/loops?projectId=    per-loop ticket counts (planner NOT run)
 *   POST   /api/plugins/:id/loops/:name/advance { projectId } → one advance of a converging
 *            loop: plan, then a ticket per outstanding unit for the board's monitor to start
 *   POST   /api/plugins/:id/loops/:name/pause  { projectId } → stops the monitor's
 *            auto-advance for this loop only (manual "Advance now" still works)
 *   POST   /api/plugins/:id/loops/:name/resume { projectId } → re-arms auto-advance
 *
 * The client's flat per-project listings live under the `/projects` prefix
 * (convention: per-project reads hang off /projects/:projectId/...):
 *
 *   GET    /api/projects/:projectId/plugin-views     (view host — views only)
 *   GET    /api/projects/:projectId/plugin-surface   (Plugins panel — views+loops+scripts+skills)
 */
export function createPluginsRoute(
  database: Database,
  options?: { getSessionManager?: () => SessionManager; boardEvents?: BoardEvents },
) {
  const router = createRouter();
  const issueService = createIssueService({
    database,
    boardEvents: options?.boardEvents,
    sendWebhook: createWebhookSender(database),
  });
  const workspaceService = createWorkspaceService({
    database,
    getSessionManager: options?.getSessionManager,
    boardEvents: options?.boardEvents,
  });
  const service = getPluginService(database, {
    createIssue: issueService.createIssue,
    createWorkspace: workspaceService.createWorkspace,
  });

  router.get("/", async (c) => {
    const projectId = c.req.query("projectId") || undefined;
    return c.json(await service.listPlugins(projectId));
  });

  router.post("/", async (c) => {
    const body = await parseJsonBody(c);
    const source = typeof body.source === "string" ? body.source : "";
    return c.json(await service.installPlugin({ source }), 201);
  });

  router.delete("/:id", async (c) => {
    await service.removePlugin(c.req.param("id"));
    return c.json({ success: true });
  });

  async function requireProjectId(c: Context): Promise<string> {
    const body = await parseOptionalJsonBody<{ projectId?: string }>(c);
    const projectId = typeof body.projectId === "string" ? body.projectId.trim() : "";
    if (!projectId) throw new PluginError("projectId is required", "BAD_REQUEST");
    return projectId;
  }

  router.post("/:id/enable", async (c) => {
    const projectId = await requireProjectId(c);
    return c.json(await service.enableForProject(c.req.param("id"), projectId));
  });

  router.post("/:id/disable", async (c) => {
    const projectId = await requireProjectId(c);
    return c.json(await service.disableForProject(c.req.param("id"), projectId));
  });

  router.get("/:id/views", async (c) => {
    const projectId = c.req.query("projectId")?.trim();
    if (!projectId) throw new PluginError("projectId query param is required", "BAD_REQUEST");
    return c.json(await service.listViews(c.req.param("id"), projectId));
  });

  router.post("/:id/views/:viewId/start", async (c) => {
    const projectId = await requireProjectId(c);
    return c.json(await service.startView(c.req.param("id"), c.req.param("viewId"), projectId));
  });

  router.post("/:id/views/:viewId/stop", async (c) => {
    const projectId = await requireProjectId(c);
    return c.json(await service.stopView(c.req.param("id"), c.req.param("viewId"), projectId));
  });

  router.get("/:id/loops", async (c) => {
    const projectId = c.req.query("projectId")?.trim();
    if (!projectId) throw new PluginError("projectId query param is required", "BAD_REQUEST");
    return c.json(await service.listLoops(c.req.param("id"), projectId));
  });

  router.post("/:id/loops/:name/advance", async (c) => {
    const projectId = await requireProjectId(c);
    return c.json(await service.advanceLoop(c.req.param("id"), c.req.param("name"), projectId));
  });

  router.post("/:id/loops/:name/pause", async (c) => {
    const projectId = await requireProjectId(c);
    return c.json(await service.setLoopPaused(c.req.param("id"), c.req.param("name"), projectId, true));
  });

  router.post("/:id/loops/:name/resume", async (c) => {
    const projectId = await requireProjectId(c);
    return c.json(await service.setLoopPaused(c.req.param("id"), c.req.param("name"), projectId, false));
  });

  router.post("/:id/scripts/:name/run", async (c) => {
    const projectId = await requireProjectId(c);
    return c.json(await service.runScript(c.req.param("id"), c.req.param("name"), projectId));
  });

  router.post("/:id/skills/:name/run", async (c) => {
    const body = await parseOptionalJsonBody<{ projectId?: string; title?: string; description?: string }>(c);
    const projectId = typeof body.projectId === "string" ? body.projectId.trim() : "";
    if (!projectId) throw new PluginError("projectId is required", "BAD_REQUEST");
    const result = await service.runSkill(c.req.param("id"), c.req.param("name"), projectId, {
      title: body.title,
      description: body.description,
    });
    return c.json(result, 201);
  });

  return router;
}

/** Mounted at `/projects` — the flat enabled-plugin listings the client panels read. */
export function createPluginProjectViewsRoute(database: Database) {
  const router = createRouter();
  const service = getPluginService(database);

  router.get("/:projectId/plugin-views", async (c) => {
    return c.json(await service.listProjectViews(c.req.param("projectId")));
  });

  router.get("/:projectId/plugin-surface", async (c) => {
    return c.json(await service.listProjectSurface(c.req.param("projectId")));
  });

  return router;
}
