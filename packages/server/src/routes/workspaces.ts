import { Hono } from "hono";
import { db } from "../db/index.js";
import { workspaces, issues } from "@agentic-kanban/shared/schema";
import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import type { Database } from "../db/index.js";

export function createWorkspacesRoute(database: Database = db) {
  const router = new Hono();

  // POST /api/workspaces
  router.post("/", async (c) => {
    const body = await c.req.json();
    if (!body.issueId || !body.branch) {
      return c.json({ error: "issueId and branch are required" }, 400);
    }

    const now = new Date().toISOString();
    const id = randomUUID();

    await database.insert(workspaces).values({
      id,
      issueId: body.issueId,
      branch: body.branch,
      workingDir: body.workingDir ?? null,
      status: "active",
      createdAt: now,
      updatedAt: now,
    });

    return c.json(
      { id, issueId: body.issueId, branch: body.branch, status: "active" },
      201,
    );
  });

  // GET /api/workspaces/:id
  router.get("/:id", async (c) => {
    const id = c.req.param("id");

    const result = await database
      .select({
        id: workspaces.id,
        issueId: workspaces.issueId,
        branch: workspaces.branch,
        workingDir: workspaces.workingDir,
        status: workspaces.status,
        createdAt: workspaces.createdAt,
        updatedAt: workspaces.updatedAt,
        issueTitle: issues.title,
        issuePriority: issues.priority,
      })
      .from(workspaces)
      .innerJoin(issues, eq(workspaces.issueId, issues.id))
      .where(eq(workspaces.id, id));

    if (result.length === 0) {
      return c.json({ error: "Workspace not found" }, 404);
    }

    const row = result[0];
    return c.json({
      id: row.id,
      issueId: row.issueId,
      branch: row.branch,
      workingDir: row.workingDir,
      status: row.status,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      issue: { title: row.issueTitle, priority: row.issuePriority },
    });
  });

  // PATCH /api/workspaces/:id
  router.patch("/:id", async (c) => {
    const id = c.req.param("id");
    const body = await c.req.json();
    const now = new Date().toISOString();

    const validStatuses = ["active", "idle", "closed"];
    if (body.status && !validStatuses.includes(body.status)) {
      return c.json({ error: "Invalid status. Must be active, idle, or closed" }, 400);
    }

    const updates: Record<string, unknown> = { updatedAt: now };
    if (body.status !== undefined) updates.status = body.status;
    if (body.workingDir !== undefined) updates.workingDir = body.workingDir;

    await database.update(workspaces).set(updates).where(eq(workspaces.id, id));

    return c.json({ id });
  });

  // DELETE /api/workspaces/:id
  router.delete("/:id", async (c) => {
    const id = c.req.param("id");
    await database.delete(workspaces).where(eq(workspaces.id, id));
    return c.json({ success: true });
  });

  return router;
}

export const workspacesRoute = createWorkspacesRoute();
