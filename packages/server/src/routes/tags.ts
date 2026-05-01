import { Hono } from "hono";
import { db } from "../db/index.js";
import { tags } from "@agentic-kanban/shared/schema";
import { randomUUID } from "node:crypto";

export function createTagsRoute() {
  const router = new Hono();

  // GET /api/tags
  router.get("/", async (c) => {
    const result = await db.select().from(tags);
    return c.json(result);
  });

  // POST /api/tags
  router.post("/", async (c) => {
    const body = await c.req.json();
    if (!body.name) {
      return c.json({ error: "name is required" }, 400);
    }

    const id = randomUUID();
    await db.insert(tags).values({
      id,
      name: body.name,
      color: body.color ?? null,
      createdAt: new Date().toISOString(),
    });

    return c.json({ id, name: body.name, color: body.color ?? null }, 201);
  });

  return router;
}

export const tagsRoute = createTagsRoute();
