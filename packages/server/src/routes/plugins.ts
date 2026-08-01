import type { Context } from "hono";
import type { Database } from "../db/index.js";
import { createRouter } from "../middleware/create-router.js";
import { parseJsonBody, parseOptionalJsonBody } from "../middleware/parse-body.js";
import { getPluginService, PluginError } from "../services/plugin.service.js";

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
 *
 * The client view host's flat listing lives under the `/projects` prefix
 * (convention: per-project reads hang off /projects/:projectId/...):
 *
 *   GET    /api/projects/:projectId/plugin-views
 */
export function createPluginsRoute(database: Database) {
  const router = createRouter();
  const service = getPluginService(database);

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

  router.post("/:id/scripts/:name/run", async (c) => {
    const projectId = await requireProjectId(c);
    return c.json(await service.runScript(c.req.param("id"), c.req.param("name"), projectId));
  });

  return router;
}

/** Mounted at `/projects` — the flat enabled-views listing for the client view host. */
export function createPluginProjectViewsRoute(database: Database) {
  const router = createRouter();
  const service = getPluginService(database);

  router.get("/:projectId/plugin-views", async (c) => {
    return c.json(await service.listProjectViews(c.req.param("projectId")));
  });

  return router;
}
