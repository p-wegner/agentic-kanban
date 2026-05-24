import { Hono } from "hono";
import { db } from "../db/index.js";
import { issues, projectStatuses, workspaces, tags, issueTags, diffComments, issueDependencies, agentSkills, issueArtifacts } from "@agentic-kanban/shared/schema";
import type { DependencyType } from "@agentic-kanban/shared/schema";
import { eq, and, inArray } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import type { Database } from "../db/index.js";
import type { BoardEvents } from "../services/board-events.js";
import { analyzeDependencies, enhanceIssue } from "../services/issue-ai.service.js";
import { getIssueSummary, resolveNewIssueDefaults } from "../repositories/issue.repository.js";
import { wouldCreateCycle, enrichWorkspacesWithSessionData } from "../services/board-aggregation.service.js";
import { deleteWorkspaceCascade } from "../repositories/workspace.repository.js";

export function createIssuesRoute(database: Database = db, options?: { boardEvents?: BoardEvents }) {
  const router = new Hono();

  // GET /api/issues?projectId=...&issueNumber=N
  router.get("/", async (c) => {
    const projectId = c.req.query("projectId");
    if (!projectId) {
      return c.json({ error: "projectId query parameter required" }, 400);
    }

    const issueNumberParam = c.req.query("issueNumber");
    const whereClause = issueNumberParam
      ? and(eq(issues.projectId, projectId), eq(issues.issueNumber, Number(issueNumberParam)))
      : eq(issues.projectId, projectId);

    const result = await database
      .select({
        id: issues.id,
        issueNumber: issues.issueNumber,
        title: issues.title,
        description: issues.description,
        priority: issues.priority,
        sortOrder: issues.sortOrder,
        statusId: issues.statusId,
        projectId: issues.projectId,
        createdAt: issues.createdAt,
        updatedAt: issues.updatedAt,
        statusChangedAt: issues.statusChangedAt,
        skipAutoReview: issues.skipAutoReview,
        estimate: issues.estimate,
        statusName: projectStatuses.name,
      })
      .from(issues)
      .innerJoin(projectStatuses, eq(issues.statusId, projectStatuses.id))
      .where(whereClause)
      .orderBy(issues.sortOrder);

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
    if (!body.title?.trim()) {
      return c.json({ error: "title is required" }, 400);
    }

    try {
      const result = await enhanceIssue(body.title, body.description, database);
      return c.json(result);
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
    if (!body.issueId || !body.projectId) {
      return c.json({ error: "issueId and projectId are required" }, 400);
    }

    try {
      const result = await analyzeDependencies(body.issueId, body.projectId, database);
      if (result.total > 0) {
        options?.boardEvents?.broadcast(body.projectId, "dependency_added");
      }
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
    const now = new Date().toISOString();
    const id = randomUUID();

    let issueNumber: number;
    let statusId: string;
    try {
      ({ issueNumber, statusId } = await resolveNewIssueDefaults(body.projectId, body.statusId, database));
    } catch (err: any) {
      if (err.statusCode === 400) return c.json({ error: err.message }, 400);
      throw err;
    }

    await database.insert(issues).values({
      id,
      issueNumber,
      title: body.title,
      description: body.description ?? null,
      priority: body.priority ?? "medium",
      skipAutoReview: body.skipAutoReview ?? false,
      estimate: body.estimate ?? null,
      sortOrder: body.sortOrder ?? 0,
      statusId,
      projectId: body.projectId,
      createdAt: now,
      updatedAt: now,
    });

    // Broadcast board event
    if (body.projectId) options?.boardEvents?.broadcast(body.projectId, "issue_created");

    return c.json({ id, issueNumber, title: body.title }, 201);
  });

  // GET /api/issues/:id/summary — issue summary by UUID or issue number
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
    const now = new Date().toISOString();

    const updates: Record<string, unknown> = { updatedAt: now };
    if (body.title !== undefined) updates.title = body.title;
    if (body.description !== undefined) updates.description = body.description;
    if (body.priority !== undefined) updates.priority = body.priority;
    if (body.statusId !== undefined) { updates.statusId = body.statusId; updates.statusChangedAt = now; }
    if (body.sortOrder !== undefined) updates.sortOrder = body.sortOrder;
    if (body.estimate !== undefined) updates.estimate = body.estimate;
    if (body.skipAutoReview !== undefined) updates.skipAutoReview = body.skipAutoReview;

    await database.update(issues).set(updates).where(eq(issues.id, id));

    // Resolve projectId for broadcast
    const rows = await database.select({ projectId: issues.projectId }).from(issues).where(eq(issues.id, id)).limit(1);
    if (rows.length > 0) {
      options?.boardEvents?.broadcast(rows[0].projectId, "issue_updated");
    }

    return c.json({ id });
  });

  // DELETE /api/issues/:id — cascade delete workspaces, sessions, messages, tags
  router.delete("/:id", async (c) => {
    const id = c.req.param("id");

    // Resolve projectId before delete
    const rows = await database.select({ projectId: issues.projectId }).from(issues).where(eq(issues.id, id)).limit(1);

    // Find all workspaces for this issue
    const wsRows = await database.select({ id: workspaces.id }).from(workspaces).where(eq(workspaces.issueId, id));

    // Cascade delete each workspace's diff comments, session messages, sessions
    for (const ws of wsRows) {
      await deleteWorkspaceCascade(ws.id, database);
    }

    // Delete issue tags and the issue itself
    await database.delete(issueTags).where(eq(issueTags.issueId, id));
    await database.delete(issues).where(eq(issues.id, id));

    if (rows.length > 0) {
      options?.boardEvents?.broadcast(rows[0].projectId, "issue_deleted");
    }

    return c.json({ success: true });
  });

  // GET /api/issues/:id/workspaces
  router.get("/:id/workspaces", async (c) => {
    const issueId = c.req.param("id");
    const wsRows = await database
      .select({
        id: workspaces.id,
        issueId: workspaces.issueId,
        branch: workspaces.branch,
        workingDir: workspaces.workingDir,
        baseBranch: workspaces.baseBranch,
        isDirect: workspaces.isDirect,
        planMode: workspaces.planMode,
        includeVisualProof: workspaces.includeVisualProof,
        requiresReview: workspaces.requiresReview,
        thoroughReview: workspaces.thoroughReview,
        readyForMerge: workspaces.readyForMerge,
        status: workspaces.status,
        agentCommand: workspaces.agentCommand,
        provider: workspaces.provider,
        skillId: workspaces.skillId,
        skillName: agentSkills.name,
        createdAt: workspaces.createdAt,
        updatedAt: workspaces.updatedAt,
        closedAt: workspaces.closedAt,
      })
      .from(workspaces)
      .leftJoin(agentSkills, eq(workspaces.skillId, agentSkills.id))
      .where(eq(workspaces.issueId, issueId));

    const wsIds = wsRows.map(w => w.id);
    const { contextTokensMap, lastToolMap } = await enrichWorkspacesWithSessionData(wsIds, database);

    const result = wsRows.map(w => ({
      ...w,
      contextTokens: contextTokensMap.get(w.id) ?? null,
      lastTool: lastToolMap.get(w.id) ?? null,
    }));

    return c.json(result);
  });

  // GET /api/issues/:id/tags
  router.get("/:id/tags", async (c) => {
    const issueId = c.req.param("id");
    const result = await database
      .select({ id: tags.id, name: tags.name, color: tags.color })
      .from(issueTags)
      .innerJoin(tags, eq(issueTags.tagId, tags.id))
      .where(eq(issueTags.issueId, issueId));
    return c.json(result);
  });

  // POST /api/issues/:id/tags — assign tag to issue
  router.post("/:id/tags", async (c) => {
    const issueId = c.req.param("id");
    const body = await c.req.json();
    if (!body.tagId) {
      return c.json({ error: "tagId is required" }, 400);
    }
    const id = randomUUID();
    await database.insert(issueTags).values({ id, issueId, tagId: body.tagId });
    return c.json({ id }, 201);
  });

  // DELETE /api/issues/:id/tags/:tagId — remove tag from issue
  router.delete("/:id/tags/:tagId", async (c) => {
    const issueId = c.req.param("id");
    const tagId = c.req.param("tagId");
    await database.delete(issueTags)
      .where(and(eq(issueTags.issueId, issueId), eq(issueTags.tagId, tagId)));
    return c.json({ success: true });
  });

  // GET /api/issues/:id/dependencies
  router.get("/:id/dependencies", async (c) => {
    const issueId = c.req.param("id");

    // Outgoing dependencies: this issue -> other issues
    const outgoing = await database
      .select({
        id: issueDependencies.id,
        issueId: issueDependencies.issueId,
        dependsOnId: issueDependencies.dependsOnId,
        type: issueDependencies.type,
        createdAt: issueDependencies.createdAt,
        issueTitle: issues.title,
        issueStatusName: projectStatuses.name,
        issueNumber: issues.issueNumber,
      })
      .from(issueDependencies)
      .innerJoin(issues, eq(issueDependencies.dependsOnId, issues.id))
      .innerJoin(projectStatuses, eq(issues.statusId, projectStatuses.id))
      .where(eq(issueDependencies.issueId, issueId));

    // Incoming dependencies: other issues -> this issue
    const incoming = await database
      .select({
        id: issueDependencies.id,
        issueId: issueDependencies.issueId,
        dependsOnId: issueDependencies.dependsOnId,
        type: issueDependencies.type,
        createdAt: issueDependencies.createdAt,
        issueTitle: issues.title,
        issueStatusName: projectStatuses.name,
        issueNumber: issues.issueNumber,
      })
      .from(issueDependencies)
      .innerJoin(issues, eq(issueDependencies.issueId, issues.id))
      .innerJoin(projectStatuses, eq(issues.statusId, projectStatuses.id))
      .where(eq(issueDependencies.dependsOnId, issueId));

    return c.json({ dependencies: [...outgoing, ...incoming] });
  });

  // POST /api/issues/:id/dependencies — add dependency with cycle detection
  router.post("/:id/dependencies", async (c) => {
    const issueId = c.req.param("id");
    const body = await c.req.json();
    const { dependsOnId, type } = body;

    if (!dependsOnId) {
      return c.json({ error: "dependsOnId is required" }, 400);
    }
    if (dependsOnId === issueId) {
      return c.json({ error: "An issue cannot depend on itself" }, 400);
    }

    const depType = type || "depends_on";
    const validTypes = ["depends_on", "blocked_by", "related_to", "duplicates", "parent_of", "child_of"];
    if (!validTypes.includes(depType)) {
      return c.json({ error: `Invalid dependency type. Must be one of: ${validTypes.join(", ")}` }, 400);
    }

    // Verify both issues exist and are in the same project
    const [sourceIssue, targetIssue] = await Promise.all([
      database.select({ projectId: issues.projectId }).from(issues).where(eq(issues.id, issueId)).limit(1),
      database.select({ projectId: issues.projectId }).from(issues).where(eq(issues.id, dependsOnId)).limit(1),
    ]);

    if (sourceIssue.length === 0) return c.json({ error: "Issue not found" }, 404);
    if (targetIssue.length === 0) return c.json({ error: "Dependency target issue not found" }, 404);
    if (sourceIssue[0].projectId !== targetIssue[0].projectId) {
      return c.json({ error: "Cannot add dependencies across projects" }, 400);
    }

    // Cycle detection: only for directional types (depends_on, blocked_by, parent_of, child_of)
    if (depType === "depends_on" || depType === "blocked_by" || depType === "parent_of" || depType === "child_of") {
      const wouldCycle = await wouldCreateCycle(database, issueId, dependsOnId, sourceIssue[0].projectId);
      if (wouldCycle) {
        return c.json({ error: "Adding this dependency would create a cycle" }, 409);
      }
    }

    const id = randomUUID();
    try {
      await database.insert(issueDependencies).values({
        id,
        issueId,
        dependsOnId,
        type: depType,
        createdAt: new Date().toISOString(),
      });
    } catch (err: any) {
      if (err.message?.includes("UNIQUE constraint")) {
        return c.json({ error: "This dependency already exists" }, 409);
      }
      throw err;
    }

    options?.boardEvents?.broadcast(sourceIssue[0].projectId, "dependency_added");

    return c.json({ id, type: depType }, 201);
  });

  // DELETE /api/issues/:id/dependencies/:depId — remove dependency by row ID
  router.delete("/:id/dependencies/:depId", async (c) => {
    const issueId = c.req.param("id");
    const depId = c.req.param("depId");

    await database.delete(issueDependencies)
      .where(and(eq(issueDependencies.id, depId), eq(issueDependencies.issueId, issueId)));

    // Resolve projectId for broadcast
    const rows = await database.select({ projectId: issues.projectId }).from(issues).where(eq(issues.id, issueId)).limit(1);
    if (rows.length > 0) {
      options?.boardEvents?.broadcast(rows[0].projectId, "dependency_removed");
    }

    return c.json({ success: true });
  });

  // GET /api/issues/:id/artifacts
  router.get("/:id/artifacts", async (c) => {
    const issueId = c.req.param("id");
    const result = await database
      .select()
      .from(issueArtifacts)
      .where(eq(issueArtifacts.issueId, issueId))
      .orderBy(issueArtifacts.createdAt);
    return c.json(result);
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
    if (!body.type || !body.content) {
      return c.json({ error: "type and content are required" }, 400);
    }
    const validTypes = ["image", "text", "link", "video"];
    if (!validTypes.includes(body.type)) {
      return c.json({ error: `type must be one of: ${validTypes.join(", ")}` }, 400);
    }

    const id = randomUUID();
    await database.insert(issueArtifacts).values({
      id,
      issueId,
      workspaceId: body.workspaceId ?? null,
      type: body.type,
      mimeType: body.mimeType ?? null,
      content: body.content,
      caption: body.caption ?? null,
    });

    // Resolve projectId for broadcast
    const rows = await database.select({ projectId: issues.projectId }).from(issues).where(eq(issues.id, issueId)).limit(1);
    if (rows.length > 0) {
      options?.boardEvents?.broadcast(rows[0].projectId, "issue_updated");
    }

    return c.json({ id }, 201);
  });

  // DELETE /api/issues/:id/artifacts/:artifactId
  router.delete("/:id/artifacts/:artifactId", async (c) => {
    const issueId = c.req.param("id");
    const artifactId = c.req.param("artifactId");
    await database.delete(issueArtifacts)
      .where(and(eq(issueArtifacts.id, artifactId), eq(issueArtifacts.issueId, issueId)));
    return c.json({ success: true });
  });

  return router;
}

export const issuesRoute = createIssuesRoute();
