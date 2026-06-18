import type { Database } from "../db/index.js";
import { createRouter } from "../middleware/create-router.js";
import { parseJsonBody } from "../middleware/parse-body.js";
import type { BoardEvents } from "../services/board-events.js";
import { createWorkflowService } from "../services/workflow.service.js";

interface WorkflowsRouteOptions {
  boardEvents?: BoardEvents;
  /** Hook to run fork/join orchestration after a transition. */
  onWorkflowAdvanced?: (workspaceId: string) => void;
}

export function createWorkflowsRoute(database: Database, options?: WorkflowsRouteOptions) {
  const router = createRouter();
  const service = createWorkflowService({
    database,
    boardEvents: options?.boardEvents,
    onWorkflowAdvanced: options?.onWorkflowAdvanced,
  });

  // GET /api/workflows/templates?projectId=&ticketType=&graph=1
  router.get("/templates", async (c) => {
    const result = await service.listTemplates({
      projectId: c.req.query("projectId"),
      ticketType: c.req.query("ticketType"),
      withGraph: c.req.query("graph") === "1",
    });
    return c.json(result);
  });

  // GET /api/workflows/templates/:id — full graph for one template.
  router.get("/templates/:id", async (c) => {
    const result = await service.getTemplate(c.req.param("id"));
    if ("error" in result) return c.json({ error: result.error }, 404);
    return c.json(result.data);
  });

  // GET /api/workflows/templates/:id/export — JSON envelope suitable for import.
  router.get("/templates/:id/export", async (c) => {
    const result = await service.exportTemplate(c.req.param("id"));
    if ("error" in result) return c.json({ error: result.error }, 404);
    return c.json(result.data);
  });

  // POST /api/workflows/templates — create a template (optionally cloning another).
  router.post("/templates", async (c) => {
    const body = await parseJsonBody(c);
    const { projectId, name, description, ticketType, isDefault, nodes, edges, cloneFrom } = body as any;
    const result = await service.createTemplate({
      projectId, name, description, ticketType, isDefault, nodes, edges, cloneFrom,
    });
    if ("error" in result) {
      const status = result.error === "cloneFrom template not found" ? 404
        : 400;
      return c.json({ error: result.error, errors: result.errors }, status);
    }
    return c.json(result.data, 201);
  });

  // POST /api/workflows/templates/import — import JSON as a new project template.
  router.post("/templates/import", async (c) => {
    const body = await parseJsonBody(c);
    const projectId = (body as any)?.projectId;
    const result = await service.importTemplate({ projectId, raw: body });
    if ("error" in result) {
      return c.json({ error: result.error, errors: result.errors }, 400);
    }
    return c.json(result.data, 201);
  });

  // PUT /api/workflows/templates/:id — update a non-builtin template's graph in place.
  router.put("/templates/:id", async (c) => {
    const id = c.req.param("id");
    const body = await parseJsonBody(c);
    const { name, description, ticketType, isDefault, nodes, edges } = body as any;
    const result = await service.updateTemplate(id, { name, description, ticketType, isDefault, nodes, edges });
    if ("error" in result) {
      const status = result.error === "Template not found" ? 404 : 400;
      return c.json({ error: result.error, errors: result.errors }, status);
    }
    return c.json(result.data);
  });

  // DELETE /api/workflows/templates/:id — delete a non-builtin template (cascade nodes/edges).
  router.delete("/templates/:id", async (c) => {
    const result = await service.deleteTemplate(c.req.param("id"));
    if ("error" in result) {
      const status = result.error === "Template not found" ? 404 : 400;
      return c.json({ error: result.error }, status);
    }
    return c.json({ ok: true });
  });

  // GET /api/workflows/analytics?projectId=
  router.get("/analytics", async (c) => {
    const projectId = c.req.query("projectId");
    if (!projectId) return c.json({ error: "projectId required" }, 400);
    const result = await service.getAnalytics(projectId);
    return c.json(result);
  });

  // GET /api/workflows/analytics/:templateId/:nodeId/workspaces?projectId=
  router.get("/analytics/:templateId/:nodeId/workspaces", async (c) => {
    const result = await service.getStageWorkspaceVisits({
      templateId: c.req.param("templateId"),
      nodeId: c.req.param("nodeId"),
      projectId: c.req.query("projectId"),
    });
    if ("error" in result) return c.json({ error: result.error }, 404);
    return c.json(result.data);
  });

  // GET /api/workflows/resolve?issueId=&projectId=&issueType=
  router.get("/resolve", async (c) => {
    const result = await service.resolveTemplate({
      issueId: c.req.query("issueId"),
      projectId: c.req.query("projectId"),
      issueType: c.req.query("issueType"),
    });
    if ("error" in result) {
      const status = result.error === "Issue not found" ? 404 : 400;
      return c.json({ error: result.error }, status);
    }
    return c.json(result.data);
  });

  // GET /api/workflows/workspaces/:id/progress
  router.get("/workspaces/:id/progress", async (c) => {
    const result = await service.getWorkspaceProgress(c.req.param("id"));
    if ("error" in result) return c.json({ error: result.error }, 404);
    return c.json(result.data);
  });

  // POST /api/workflows/workspaces/:id/transition — manual transition (UI-driven).
  router.post("/workspaces/:id/transition", async (c) => {
    const body = await parseJsonBody(c);
    const { toNodeId, toNodeName, summary } = body as {
      toNodeId?: string;
      toNodeName?: string;
      summary?: string;
    };
    const result = await service.executeTransition(c.req.param("id"), { toNodeId, toNodeName, summary });
    if (result.error) return c.json({ error: result.error }, 400);
    return c.json(result.data);
  });

  return router;
}
