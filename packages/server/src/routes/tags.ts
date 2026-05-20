import { Hono } from "hono";
import { db } from "../db/index.js";
import type { Database } from "../db/index.js";
import { tags, issueTags } from "@agentic-kanban/shared/schema";
import { eq, inArray } from "drizzle-orm";
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

  // POST /api/tags/merge — merge sourceIds into targetId, then delete sources
  router.post("/merge", async (c) => {
    const body = await c.req.json();
    const { targetId, sourceIds } = body as { targetId: string; sourceIds: string[] };
    if (!targetId || !Array.isArray(sourceIds) || sourceIds.length === 0) {
      return c.json({ error: "targetId and sourceIds are required" }, 400);
    }
    const toMerge = sourceIds.filter((id) => id !== targetId);
    if (toMerge.length === 0) return c.json({ success: true });

    // Find issues that already have the target tag (to avoid duplicate associations)
    const existing = await database
      .select({ issueId: issueTags.issueId })
      .from(issueTags)
      .where(eq(issueTags.tagId, targetId));
    const alreadyTagged = new Set(existing.map((r) => r.issueId));

    // Find issues tagged with any source tag that don't already have the target
    const sourceAssociations = await database
      .select({ issueId: issueTags.issueId })
      .from(issueTags)
      .where(inArray(issueTags.tagId, toMerge));

    const toInsert = sourceAssociations
      .map((r) => r.issueId)
      .filter((id, idx, arr) => arr.indexOf(id) === idx && !alreadyTagged.has(id));

    if (toInsert.length > 0) {
      await database.insert(issueTags).values(
        toInsert.map((issueId) => ({ id: randomUUID(), issueId, tagId: targetId }))
      );
    }

    // Remove source tag associations and delete source tags
    await database.delete(issueTags).where(inArray(issueTags.tagId, toMerge));
    await database.delete(tags).where(inArray(tags.id, toMerge));

    return c.json({ success: true, merged: toMerge.length });
  });

  return router;
}

export const tagsRoute = createTagsRoute();
