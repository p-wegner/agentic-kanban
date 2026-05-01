import { Hono } from "hono";
import { db } from "../db/index.js";
import { issues, projectStatuses, workspaces } from "@agentic-kanban/shared/schema";
import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import type { Database } from "../db/index.js";

export function createIssuesRoute(database: Database = db) {
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

    return c.json({ id });
  });

  // DELETE /api/issues/:id
  router.delete("/:id", async (c) => {
    const id = c.req.param("id");
    await database.delete(issues).where(eq(issues.id, id));
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

  return router;
}

export const issuesRoute = createIssuesRoute();
