import { Hono } from "hono";
import { projectStatuses, issues } from "@agentic-kanban/shared/schema";
import { eq, and } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import type { Database } from "../../db/index.js";

export function createStatusRoutes(database: Database) {
  const router = new Hono();

  router.get("/:id/statuses", async (c) => {
    const projectId = c.req.param("id");
    const result = await database
      .select()
      .from(projectStatuses)
      .where(eq(projectStatuses.projectId, projectId))
      .orderBy(projectStatuses.sortOrder);
    return c.json(result);
  });

  router.post("/:id/statuses", async (c) => {
    const projectId = c.req.param("id");
    const body = await c.req.json();
    const now = new Date().toISOString();
    const id = randomUUID();

    await database.insert(projectStatuses).values({
      id,
      projectId,
      name: body.name,
      sortOrder: body.sortOrder ?? 0,
      createdAt: now,
    });

    return c.json({ id, projectId, name: body.name }, 201);
  });

  router.delete("/:id/statuses/:statusId", async (c) => {
    const projectId = c.req.param("id");
    const statusId = c.req.param("statusId");

    const statusRows = await database
      .select()
      .from(projectStatuses)
      .where(and(eq(projectStatuses.id, statusId), eq(projectStatuses.projectId, projectId)));

    if (statusRows.length === 0) {
      return c.json({ error: "Status not found" }, 404);
    }

    const linkedIssues = await database
      .select({ id: issues.id })
      .from(issues)
      .where(eq(issues.statusId, statusId))
      .limit(1);

    if (linkedIssues.length > 0) {
      return c.json({ error: "Cannot delete status with linked issues" }, 409);
    }

    await database.delete(projectStatuses).where(eq(projectStatuses.id, statusId));

    return c.json({ success: true });
  });

  return router;
}
