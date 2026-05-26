import { Hono } from "hono";
import { db } from "../db/index.js";
import type { Database } from "../db/index.js";
import type { BoardEvents } from "../services/board-events.js";
import { analyzeDependencies, enhanceIssue } from "../services/issue-ai.service.js";
import { IssueError, createIssueService } from "../services/issue.service.js";
import { enrichWorkspacesWithSessionData } from "../services/board-aggregation.service.js";
import {
  getIssuesByProject,
  getIssueSummary,
  getIssueTags,
  getOutgoingDependencies,
  getIncomingDependencies,
  getIssueWorkspaces,
  getIssueArtifacts,
  assignTag,
  removeTag,
  deleteArtifact,
} from "../repositories/issue.repository.js";

export function createIssuesRoute(database: Database = db, options?: { boardEvents?: BoardEvents }) {
  const router = new Hono();

  const issueService = createIssueService({ database, boardEvents: options?.boardEvents });

  // GET /api/issues?projectId=...&issueNumber=N
  router.get("/", async (c) => {
    const projectId = c.req.query("projectId");
    if (!projectId) return c.json({ error: "projectId query parameter required" }, 400);
    const issueNumberParam = c.req.query("issueNumber");
    const result = await getIssuesByProject(
      projectId,
      issueNumberParam ? Number(issueNumberParam) : undefined,
      database,
    );
    return c.json(result);
  });

  // POST /api/issues/enhance — AI-enhance a ticket title and description
  router.post("/enhance", async (c) => {
    let body: { title: string; description?: string; projectId?: string };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "invalid JSON body" }, 400);
    }
    if (!body.title?.trim()) return c.json({ error: "title is required" }, 400);

    try {
      return c.json(await enhanceIssue(body.title, body.description, database));
    } catch (err: any) {
      if (err.message?.includes("JSON") || err instanceof SyntaxError) {
        console.error("[enhance] failed to parse claude output:", err.message);
        return c.json({ error: "Failed to parse AI response" }, 500);
      }
      const parts: string[] = [];
      if (err.message) parts.push(err.message);
      if (err.stderr) parts.push(String(err.stderr).trim());
      const msg = parts.length > 0 ? parts.join(" | ") : "claude CLI failed";
      console.error("[enhance] claude error:", msg);
      return c.json({ error: "AI enhancement failed", detail: msg }, 500);
    }
  });

  // POST /api/issues/analyze-dependencies — AI-analyze dependencies for an issue
  router.post("/analyze-dependencies", async (c) => {
    let body: { issueId: string; projectId: string };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "invalid JSON body" }, 400);
    }
    if (!body.issueId || !body.projectId) return c.json({ error: "issueId and projectId are required" }, 400);

    try {
      const result = await analyzeDependencies(body.issueId, body.projectId, database);
      if (result.total > 0) options?.boardEvents?.broadcast(body.projectId, "dependency_added");
      return c.json(result);
    } catch (err: any) {
      if (err.statusCode === 404) return c.json({ error: err.message }, 404);
      if (err.message?.includes("JSON")) {
        console.error("[analyze-deps] failed to parse claude output:", err.message);
        return c.json({ error: "Failed to parse AI response" }, 500);
      }
      const parts: string[] = [];
      if (err.message) parts.push(err.message);
      if (err.stderr) parts.push(String(err.stderr).trim());
      const msg = parts.length > 0 ? parts.join(" | ") : "claude CLI failed";
      console.error("[analyze-deps] error:", msg);
      return c.json({ error: "AI dependency analysis failed", detail: msg }, 500);
    }
  });

  // POST /api/issues
  router.post("/", async (c) => {
    const body = await c.req.json();
    if (!body.projectId) return c.json({ error: "projectId is required" }, 400);
    if (!body.title?.trim()) return c.json({ error: "title is required" }, 400);

    try {
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
      });
      return c.json(result, 201);
    } catch (err) {
      if (err instanceof IssueError) {
        return c.json({ error: err.message }, err.code === "NOT_FOUND" ? 404 : 400);
      }
      throw err;
    }
  });

  // GET /api/issues/:id/summary
  router.get("/:id/summary", async (c) => {
    const idParam = c.req.param("id");
    const result = await getIssueSummary(idParam, database);
    if (!result) return c.json({ error: "Issue not found" }, 404);
    return c.json(result);
  });

  // PATCH /api/issues/:id
  router.patch("/:id", async (c) => {
    const id = c.req.param("id");
    const body = await c.req.json();
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
    const wsRows = await getIssueWorkspaces(issueId, database);
    const wsIds = wsRows.map((w: any) => w.id);
    const { contextTokensMap, lastToolMap } = await enrichWorkspacesWithSessionData(wsIds, database);
    return c.json(wsRows.map((w: any) => ({
      ...w,
      contextTokens: contextTokensMap.get(w.id) ?? null,
      lastTool: lastToolMap.get(w.id) ?? null,
    })));
  });

  // GET /api/issues/:id/tags
  router.get("/:id/tags", async (c) => {
    const issueId = c.req.param("id");
    return c.json(await getIssueTags(issueId, database));
  });

  // POST /api/issues/:id/tags
  router.post("/:id/tags", async (c) => {
    const issueId = c.req.param("id");
    const body = await c.req.json();
    if (!body.tagId) return c.json({ error: "tagId is required" }, 400);
    const result = await assignTag(issueId, body.tagId, database);
    return c.json(result, 201);
  });

  // DELETE /api/issues/:id/tags/:tagId
  router.delete("/:id/tags/:tagId", async (c) => {
    const issueId = c.req.param("id");
    const tagId = c.req.param("tagId");
    await removeTag(issueId, tagId, database);
    return c.json({ success: true });
  });

  // GET /api/issues/:id/dependencies
  router.get("/:id/dependencies", async (c) => {
    const issueId = c.req.param("id");
    const [outgoing, incoming] = await Promise.all([
      getOutgoingDependencies(issueId, database),
      getIncomingDependencies(issueId, database),
    ]);
    return c.json({ dependencies: [...outgoing, ...incoming] });
  });

  // POST /api/issues/:id/dependencies
  router.post("/:id/dependencies", async (c) => {
    const issueId = c.req.param("id");
    const body = await c.req.json();
    if (!body.dependsOnId) return c.json({ error: "dependsOnId is required" }, 400);

    try {
      const result = await issueService.addDependency(issueId, body.dependsOnId, body.type);
      return c.json({ id: result.id, type: result.type }, 201);
    } catch (err) {
      if (err instanceof IssueError) {
        const code = err.code === "CONFLICT" ? 409 : err.code === "NOT_FOUND" ? 404 : 400;
        return c.json({ error: err.message }, code);
      }
      throw err;
    }
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
    return c.json(await getIssueArtifacts(issueId, database));
  });

  // POST /api/issues/:id/artifacts
  router.post("/:id/artifacts", async (c) => {
    const issueId = c.req.param("id");
    let body: { type: string; mimeType?: string; content: string; caption?: string; workspaceId?: string };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "invalid JSON body" }, 400);
    }
    if (!body.type || !body.content) return c.json({ error: "type and content are required" }, 400);

    try {
      const result = await issueService.addArtifact(issueId, body);
      return c.json({ id: result.id }, 201);
    } catch (err) {
      if (err instanceof IssueError) return c.json({ error: err.message }, 400);
      throw err;
    }
  });

  // DELETE /api/issues/:id/artifacts/:artifactId
  router.delete("/:id/artifacts/:artifactId", async (c) => {
    const issueId = c.req.param("id");
    const artifactId = c.req.param("artifactId");
    await deleteArtifact(issueId, artifactId, database);
    return c.json({ success: true });
  });

  return router;
}

export const issuesRoute = createIssuesRoute();
