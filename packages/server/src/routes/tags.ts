import { Hono } from "hono";
import { db } from "../db/index.js";
import type { Database } from "../db/index.js";
import { tags, issueTags } from "@agentic-kanban/shared/schema";
import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";

export function createTagsRoute(database: Database = db) {
  const router = new Hono();

  // GET /api/tags
  router.get("/", async (c) => {
    const result = await database.select().from(tags);
    return c.json(result);
  });

  // POST /api/tags
  router.post("/", async (c) => {
    const body = await c.req.json();
    if (!body.name) {
      return c.json({ error: "name is required" }, 400);
    }

    const id = randomUUID();
    await database.insert(tags).values({
      id,
      name: body.name,
      color: body.color ?? null,
      createdAt: new Date().toISOString(),
    });

    return c.json({ id, name: body.name, color: body.color ?? null }, 201);
  });

  // PATCH /api/tags/:id
  router.patch("/:id", async (c) => {
    const id = c.req.param("id");
    const body = await c.req.json();

    const updates: Record<string, unknown> = {};
    if (body.name !== undefined) updates.name = body.name;
    if (body.color !== undefined) updates.color = body.color;

    if (Object.keys(updates).length === 0) {
      return c.json({ error: "No fields to update" }, 400);
    }

    await database.update(tags).set(updates).where(eq(tags.id, id));
    return c.json({ id });
  });

  // DELETE /api/tags/:id
  router.delete("/:id", async (c) => {
    const id = c.req.param("id");
    // Remove all issue associations first
    await database.delete(issueTags).where(eq(issueTags.tagId, id));
    await database.delete(tags).where(eq(tags.id, id));
    return c.json({ success: true });
  });

  return router;
}

export const tagsRoute = createTagsRoute();
