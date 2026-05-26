import { Hono } from "hono";
import { db } from "../db/index.js";
import type { Database } from "../db/index.js";
import { randomUUID } from "node:crypto";
import {
  getAllTags,
  createTag,
  getTagById,
  updateTag,
  deleteTag,
  getTagsByIds,
  getIssueIdsWithTag,
  getIssueIdsByTagIds,
  addIssueTagEntries,
  removeIssueTagsByTagIds,
  deleteTagsByIds,
} from "../repositories/tag.repository.js";

export function createTagsRoute(database: Database = db) {
  const router = new Hono();

  // GET /api/tags
  router.get("/", async (c) => {
    return c.json(await getAllTags(database));
  });

  // POST /api/tags
  router.post("/", async (c) => {
    const body = await c.req.json();
    if (!body.name) {
      return c.json({ error: "name is required" }, 400);
    }
    const result = await createTag(body.name, body.color ?? null, database);
    return c.json(result, 201);
  });

  // PATCH /api/tags/:id
  router.patch("/:id", async (c) => {
    const id = c.req.param("id");
    const existing = await getTagById(id, database);
    if (!existing) return c.json({ error: "Tag not found" }, 404);
    if (existing.isBuiltin) return c.json({ error: "Built-in tags cannot be modified" }, 403);

    const body = await c.req.json();
    const updates: Record<string, unknown> = {};
    if (body.name !== undefined) updates.name = body.name;
    if (body.color !== undefined) updates.color = body.color;

    if (Object.keys(updates).length === 0) {
      return c.json({ error: "No fields to update" }, 400);
    }

    await updateTag(id, updates, database);
    return c.json({ id });
  });

  // DELETE /api/tags/:id
  router.delete("/:id", async (c) => {
    const id = c.req.param("id");
    const existing = await getTagById(id, database);
    if (!existing) return c.json({ error: "Tag not found" }, 404);
    if (existing.isBuiltin) return c.json({ error: "Built-in tags cannot be deleted" }, 403);

    await deleteTag(id, database);
    return c.json({ success: true });
  });

  // POST /api/tags/merge — merge sourceIds into targetId, then delete sources
  router.post("/merge", async (c) => {
    const body = await c.req.json();
    const { targetId, sourceIds } = body as { targetId: string; sourceIds: string[] };
    if (!targetId || !Array.isArray(sourceIds) || sourceIds.length === 0) {
      return c.json({ error: "targetId and sourceIds are required" }, 400);
    }
    const toMerge = sourceIds.filter((id) => id !== targetId);
    if (toMerge.length === 0) return c.json({ success: true });

    // Prevent merging (deleting) built-in tags
    const builtinSources = await getTagsByIds(toMerge, database);
    const builtinBlocked = builtinSources.filter((t) => t.isBuiltin);
    if (builtinBlocked.length > 0) {
      return c.json({ error: `Built-in tags cannot be merged away: ${builtinBlocked.map((t) => t.name).join(", ")}` }, 403);
    }

    // Find issues that already have the target tag (to avoid duplicate associations)
    const existing = await getIssueIdsWithTag(targetId, database);
    const alreadyTagged = new Set(existing.map((r) => r.issueId));

    // Find issues tagged with any source tag that don't already have the target
    const sourceAssociations = await getIssueIdsByTagIds(toMerge, database);

    const toInsert = sourceAssociations
      .map((r) => r.issueId)
      .filter((id, idx, arr) => arr.indexOf(id) === idx && !alreadyTagged.has(id));

    if (toInsert.length > 0) {
      await addIssueTagEntries(
        toInsert.map((issueId) => ({ id: randomUUID(), issueId, tagId: targetId })),
        database,
      );
    }

    // Remove source tag associations and delete source tags
    await removeIssueTagsByTagIds(toMerge, database);
    await deleteTagsByIds(toMerge, database);

    return c.json({ success: true, merged: toMerge.length });
  });

  return router;
}

export const tagsRoute = createTagsRoute();
