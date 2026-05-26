import { Hono } from "hono";
import type { Database } from "../db/index.js";
import { createTagService, TagError } from "../services/tag.service.js";

export function createTagsRoute(database: Database) {
  const router = new Hono();
  const tagService = createTagService({ database });

  // GET /api/tags
  router.get("/", async (c) => {
    return c.json(await tagService.listTags());
  });

  // POST /api/tags
  router.post("/", async (c) => {
    const body = await c.req.json();
    if (!body.name) {
      return c.json({ error: "name is required" }, 400);
    }
    const result = await tagService.createNewTag(body.name, body.color ?? null);
    return c.json(result, 201);
  });

  // PATCH /api/tags/:id
  router.patch("/:id", async (c) => {
    try {
      const body = await c.req.json();
      const result = await tagService.updateTagById(c.req.param("id"), body);
      return c.json(result);
    } catch (err) {
      if (err instanceof TagError) {
        if (err.code === "NOT_FOUND") return c.json({ error: err.message }, 404);
        if (err.code === "FORBIDDEN") return c.json({ error: err.message }, 403);
        return c.json({ error: err.message }, 400);
      }
      throw err;
    }
  });

  // DELETE /api/tags/:id
  router.delete("/:id", async (c) => {
    try {
      await tagService.deleteTagById(c.req.param("id"));
      return c.json({ success: true });
    } catch (err) {
      if (err instanceof TagError) {
        if (err.code === "NOT_FOUND") return c.json({ error: err.message }, 404);
        if (err.code === "FORBIDDEN") return c.json({ error: err.message }, 403);
        return c.json({ error: err.message }, 400);
      }
      throw err;
    }
  });

  // POST /api/tags/merge — merge sourceIds into targetId, then delete sources
  router.post("/merge", async (c) => {
    const body = await c.req.json();
    const { targetId, sourceIds } = body as { targetId: string; sourceIds: string[] };
    if (!targetId || !Array.isArray(sourceIds) || sourceIds.length === 0) {
      return c.json({ error: "targetId and sourceIds are required" }, 400);
    }
    try {
      const result = await tagService.mergeTags(targetId, sourceIds);
      return c.json({ success: true, ...result });
    } catch (err) {
      if (err instanceof TagError) {
        if (err.code === "FORBIDDEN") return c.json({ error: err.message }, 403);
        return c.json({ error: err.message }, 400);
      }
      throw err;
    }
  });

  return router;
}
