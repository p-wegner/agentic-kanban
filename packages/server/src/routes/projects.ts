import { Hono } from "hono";
import { db } from "../db/index.js";
import { projects, projectStatuses } from "@agentic-kanban/shared/schema";
import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";

export const projectsRoute = new Hono();

// GET /api/projects
projectsRoute.get("/", async (c) => {
  const result = await db.select().from(projects);
  return c.json(result);
});

// POST /api/projects
projectsRoute.post("/", async (c) => {
  const body = await c.req.json();
  const now = new Date().toISOString();
  const id = randomUUID();

  await db.insert(projects).values({
    id,
    name: body.name,
    description: body.description ?? null,
    color: body.color ?? null,
    createdAt: now,
    updatedAt: now,
  });

  return c.json({ id, name: body.name }, 201);
});

// GET /api/projects/:id/statuses
projectsRoute.get("/:id/statuses", async (c) => {
  const projectId = c.req.param("id");
  const result = await db
    .select()
    .from(projectStatuses)
    .where(eq(projectStatuses.projectId, projectId))
    .orderBy(projectStatuses.sortOrder);
  return c.json(result);
});

// POST /api/projects/:id/statuses
projectsRoute.post("/:id/statuses", async (c) => {
  const projectId = c.req.param("id");
  const body = await c.req.json();
  const now = new Date().toISOString();
  const id = randomUUID();

  await db.insert(projectStatuses).values({
    id,
    projectId,
    name: body.name,
    sortOrder: body.sortOrder ?? 0,
    createdAt: now,
  });

  return c.json({ id, projectId, name: body.name }, 201);
});
