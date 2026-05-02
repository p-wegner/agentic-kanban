import { Hono } from "hono";
import { db } from "../db/index.js";
import { issues, projectStatuses, workspaces, tags, issueTags } from "@agentic-kanban/shared/schema";
import { eq, and } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import type { Database } from "../db/index.js";
import type { BoardEvents } from "../services/board-events.js";

export function createIssuesRoute(database: Database = db, options?: { boardEvents?: BoardEvents }) {
  const router = new Hono();

  // GET /api/issues?projectId=...
  router.get("/", async (c) => {
    const projectId = c.req.query("projectId");
    if (!projectId) {
      return c.json({ error: "projectId query parameter required" }, 400);
    }

    const result = await database
      .select({
        id: issues.id,
        title: issues.title,
        description: issues.description,
        priority: issues.priority,
        sortOrder: issues.sortOrder,
        statusId: issues.statusId,
        projectId: issues.projectId,
        createdAt: issues.createdAt,
        updatedAt: issues.updatedAt,
        statusName: projectStatuses.name,
      })
      .from(issues)
      .innerJoin(projectStatuses, eq(issues.statusId, projectStatuses.id))
      .where(eq(issues.projectId, projectId))
      .orderBy(issues.sortOrder);

    return c.json(result);
  });

  // POST /api/issues
  router.post("/", async (c) => {
    const body = await c.req.json();
    const now = new Date().toISOString();
    const id = randomUUID();

    await database.insert(issues).values({
      id,
      title: body.title,
      description: body.description ?? null,
      priority: body.priority ?? "medium",
      sortOrder: body.sortOrder ?? 0,
      statusId: body.statusId,
      projectId: body.projectId,
      createdAt: now,
      updatedAt: now,
    });

    // Broadcast board event
    if (body.projectId) options?.boardEvents?.broadcast(body.projectId, "issue_created");

    return c.json({ id, title: body.title }, 201);
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
    if (body.statusId !== undefined) updates.statusId = body.statusId;
    if (body.sortOrder !== undefined) updates.sortOrder = body.sortOrder;

    await database.update(issues).set(updates).where(eq(issues.id, id));

    // Resolve projectId for broadcast
    const rows = await database.select({ projectId: issues.projectId }).from(issues).where(eq(issues.id, id)).limit(1);
    if (rows.length > 0) {
      options?.boardEvents?.broadcast(rows[0].projectId, "issue_updated");
    }

    return c.json({ id });
  });

  // DELETE /api/issues/:id
  router.delete("/:id", async (c) => {
    const id = c.req.param("id");

    // Resolve projectId before delete
    const rows = await database.select({ projectId: issues.projectId }).from(issues).where(eq(issues.id, id)).limit(1);

    await database.delete(issues).where(eq(issues.id, id));

    if (rows.length > 0) {
      options?.boardEvents?.broadcast(rows[0].projectId, "issue_deleted");
    }

    return c.json({ success: true });
  });

  // GET /api/issues/:id/workspaces
  router.get("/:id/workspaces", async (c) => {
    const issueId = c.req.param("id");
    const result = await database
      .select()
      .from(workspaces)
      .where(eq(workspaces.issueId, issueId));
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

  return router;
}

export const issuesRoute = createIssuesRoute();
