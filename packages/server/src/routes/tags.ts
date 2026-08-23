import type { Database } from "../db/index.js";
import { createTagService } from "../services/tag.service.js";
import { createRouter } from "../middleware/create-router.js";
import { parseJsonBody } from "../middleware/parse-body.js";
import { createTagBody, mergeTagsBody } from "./tag-body-schemas.js";

export function createTagsRoute(database: Database) {
  const router = createRouter();
  const tagService = createTagService({ database });

  // GET /api/tags
  router.get("/", async (c) => {
    return c.json(await tagService.listTags());
  });

  // POST /api/tags
  router.post("/", async (c) => {
    const body = await parseJsonBody(c, createTagBody);
    const result = await tagService.createNewTag(body.name, body.color ?? null);
    return c.json(result, 201);
  });

  // PATCH /api/tags/:id
  router.patch("/:id", async (c) => {
    const body = await parseJsonBody<{ name?: string; color?: string }>(c);
    const result = await tagService.updateTagById(c.req.param("id"), body);
    return c.json(result);
  });

  // DELETE /api/tags/:id
  router.delete("/:id", async (c) => {
    await tagService.deleteTagById(c.req.param("id"));
    return c.json({ success: true });
  });

  // POST /api/tags/merge — merge sourceIds into targetId, then delete sources
  router.post("/merge", async (c) => {
    const { targetId, sourceIds } = await parseJsonBody(c, mergeTagsBody);
    const result = await tagService.mergeTags(targetId, sourceIds);
    return c.json({ success: true, ...result });
  });

  return router;
}
