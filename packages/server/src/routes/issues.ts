import { Hono } from "hono";
import { db } from "../db/index.js";
import type { Database } from "../db/index.js";
import type { BoardEvents } from "../services/board-events.js";
import { analyzeDependencies, enhanceIssue, aiEstimateIssue, analyzeTouchedFiles, checkIssueOverlap } from "../services/issue-ai.service.js";
import { issues } from "@agentic-kanban/shared/schema";
import { eq } from "drizzle-orm";
import { createIssueService } from "../services/issue.service.js";
import { parseJsonBody } from "../middleware/parse-body.js";
import { createRouter } from "../middleware/create-router.js";
import { wrapAiOperation } from "../middleware/ai-operation.js";

export function createIssuesRoute(database: Database = db, options?: { boardEvents?: BoardEvents }) {
  const router = createRouter();

  const issueService = createIssueService({ database, boardEvents: options?.boardEvents });

  // GET /api/issues?projectId=...&issueNumber=N
  router.get("/", async (c) => {
    const projectId = c.req.query("projectId");
    if (!projectId) return c.json({ error: "projectId query parameter required" }, 400);
    const issueNumberParam = c.req.query("issueNumber");
    const result = await issueService.listIssues(
      projectId,
      issueNumberParam ? Number(issueNumberParam) : undefined,
    );
    return c.json(result);
  });

  // POST /api/issues/enhance — AI-enhance a ticket title and description
  router.post("/enhance", async (c) => {
    const body = await parseJsonBody<{ title: string; description?: string; projectId?: string }>(c);
    if (!body.title?.trim()) return c.json({ error: "title is required" }, 400);
    return c.json(await wrapAiOperation("enhance", () => enhanceIssue(body.title, body.description, database)));
  });

  // POST /api/issues/analyze-dependencies — AI-analyze dependencies for an issue
  router.post("/analyze-dependencies", async (c) => {
    const body = await parseJsonBody<{ issueId: string; projectId: string }>(c);
    if (!body.issueId || !body.projectId) return c.json({ error: "issueId and projectId are required" }, 400);
    const result = await wrapAiOperation("analyze-deps", () => analyzeDependencies(body.issueId, body.projectId, database));
    if (result.total > 0) options?.boardEvents?.broadcast(body.projectId, "dependency_added");
    return c.json(result);
  });

  // POST /api/issues/ai-estimate — AI-suggest a T-shirt size estimate for an issue
  router.post("/ai-estimate", async (c) => {
    const body = await parseJsonBody<{ issueId: string }>(c);
    if (!body.issueId) return c.json({ error: "issueId is required" }, 400);
    return c.json(await wrapAiOperation("ai-estimate", () => aiEstimateIssue(body.issueId, database)));
  });

  // POST /api/issues/batch — create N issues atomically
  router.post("/batch", async (c) => {
    const body = await parseJsonBody<{ projectId: string; issues: any[] }>(c);
    if (!body.projectId) return c.json({ error: "projectId is required" }, 400);
    if (!Array.isArray(body.issues)) return c.json({ error: "issues must be an array" }, 400);
    try {
      const result = await issueService.createIssuesBatch(body.projectId, body.issues);
      return c.json({ issues: result }, 201);
    } catch (err: any) {
      if (err.code === "BAD_REQUEST") {
        const payload: any = { error: err.message };
        if (typeof err.index === "number") payload.index = err.index;
        return c.json(payload, 400);
      }
      throw err;
    }
  });

  // POST /api/issues/dependencies/batch — add/remove N dependency edges atomically
  router.post("/dependencies/batch", async (c) => {
    const body = await parseJsonBody<{ edges: any[] }>(c);
    if (!Array.isArray(body.edges)) return c.json({ error: "edges must be an array" }, 400);
    try {
      const result = await issueService.updateDependenciesBatch(body.edges);
      return c.json({ added: result.added, removed: result.removed, skipped: result.skipped });
    } catch (err: any) {
      if (err.code === "BAD_REQUEST") {
        const payload: any = { error: err.message };
        if (typeof err.index === "number") payload.index = err.index;
        return c.json(payload, 400);
      }
      if (err.code === "CONFLICT") {
        const payload: any = { error: err.message };
        if (typeof err.index === "number") payload.index = err.index;
        return c.json(payload, 400);
      }
      throw err;
    }
  });

  // POST /api/issues
  router.post("/", async (c) => {
    const body = await parseJsonBody(c);
    if (!body.projectId) return c.json({ error: "projectId is required" }, 400);
    if (!body.title?.trim()) return c.json({ error: "title is required" }, 400);

    const result = await issueService.createIssue({
      projectId: body.projectId,
      title: body.title,
      description: body.description,
      priority: body.priority,
      issueType: body.issueType,
      skipAutoReview: body.skipAutoReview,
      estimate: body.estimate,
      sortOrder: body.sortOrder,
      statusId: body.statusId,
      workflowTemplateId: body.workflowTemplateId,
    });
    return c.json(result, 201);
  });

  // GET /api/issues/:id/touched-files — return cached prediction only (no AI call)
  router.get("/:id/touched-files", async (c) => {
    const issueId = c.req.param("id");
    const rows = await database.select({ touchedFilesJson: issues.touchedFilesJson }).from(issues).where(eq(issues.id, issueId)).limit(1);
    if (rows.length === 0) return c.json({ error: "Issue not found" }, 404);
    const json = rows[0].touchedFilesJson;
    const files = json ? JSON.parse(json) : [];
    return c.json({ files, cached: true });
  });

  // POST /api/issues/:id/analyze-touched-files — run (or re-run) AI prediction
  router.post("/:id/analyze-touched-files", async (c) => {
    const issueId = c.req.param("id");
    const body = await parseJsonBody<{ refresh?: boolean }>(c).catch(() => ({ refresh: false }));
    return c.json(await wrapAiOperation("analyze-touched-files", () => analyzeTouchedFiles(issueId, database, body?.refresh === true)));
  });

  // GET /api/issues/:id/summary
  router.get("/:id/summary", async (c) => {
    const idParam = c.req.param("id");
    const result = await issueService.getIssueSummary(idParam);
    if (!result) return c.json({ error: "Issue not found" }, 404);
    return c.json(result);
  });

  // PATCH /api/issues/:id
  router.patch("/:id", async (c) => {
    const id = c.req.param("id");
    const body = await parseJsonBody(c);
    const result = await issueService.updateIssue(id, body);
    return c.json({ id: result.id });
  });

  // DELETE /api/issues/:id
  router.delete("/:id", async (c) => {
    const id = c.req.param("id");
    await issueService.deleteIssue(id);
    return c.json({ success: true });
  });

  // GET /api/issues/:id/workspaces
  router.get("/:id/workspaces", async (c) => {
    const issueId = c.req.param("id");
    return c.json(await issueService.getEnrichedWorkspaces(issueId));
  });

  // GET /api/issues/:id/tags
  router.get("/:id/tags", async (c) => {
    const issueId = c.req.param("id");
    return c.json(await issueService.getTags(issueId));
  });

  // POST /api/issues/:id/tags
  router.post("/:id/tags", async (c) => {
    const issueId = c.req.param("id");
    const body = await parseJsonBody(c);
    if (!body.tagId) return c.json({ error: "tagId is required" }, 400);
    const result = await issueService.assignTag(issueId, body.tagId);
    return c.json(result, 201);
  });

  // DELETE /api/issues/:id/tags/:tagId
  router.delete("/:id/tags/:tagId", async (c) => {
    const issueId = c.req.param("id");
    const tagId = c.req.param("tagId");
    await issueService.removeTag(issueId, tagId);
    return c.json({ success: true });
  });

  // GET /api/issues/:id/dependencies
  router.get("/:id/dependencies", async (c) => {
    const issueId = c.req.param("id");
    return c.json(await issueService.getDependencies(issueId));
  });

  // POST /api/issues/:id/dependencies
  router.post("/:id/dependencies", async (c) => {
    const issueId = c.req.param("id");
    const body = await parseJsonBody(c);
    if (!body.dependsOnId) return c.json({ error: "dependsOnId is required" }, 400);

    const result = await issueService.addDependency(issueId, body.dependsOnId, body.type);
    return c.json({ id: result.id, type: result.type }, 201);
  });

  // DELETE /api/issues/:id/dependencies/:depId
  router.delete("/:id/dependencies/:depId", async (c) => {
    const issueId = c.req.param("id");
    const depId = c.req.param("depId");
    await issueService.removeDependency(issueId, depId);
    return c.json({ success: true });
  });

  // GET /api/issues/:id/artifacts
  router.get("/:id/artifacts", async (c) => {
    const issueId = c.req.param("id");
    return c.json(await issueService.getArtifacts(issueId));
  });

  // POST /api/issues/:id/artifacts
  router.post("/:id/artifacts", async (c) => {
    const issueId = c.req.param("id");
    const body = await parseJsonBody<{ type: string; mimeType?: string; content: string; caption?: string; workspaceId?: string }>(c);
    if (!body.type || !body.content) return c.json({ error: "type and content are required" }, 400);

    const result = await issueService.addArtifact(issueId, body);
    return c.json({ id: result.id }, 201);
  });

  // DELETE /api/issues/:id/artifacts/:artifactId
  router.delete("/:id/artifacts/:artifactId", async (c) => {
    const issueId = c.req.param("id");
    const artifactId = c.req.param("artifactId");
    await issueService.deleteArtifact(issueId, artifactId);
    return c.json({ success: true });
  });

  return router;
}

export const issuesRoute = createIssuesRoute();