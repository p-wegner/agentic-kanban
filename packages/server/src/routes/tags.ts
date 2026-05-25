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

    const [existing] = await database.select({ id: tags.id, isBuiltin: tags.isBuiltin })
      .from(tags).where(eq(tags.name, body.name)).limit(1);
    if (existing) {
      if (existing.isBuiltin) {
        return c.json({ error: `A built-in tag named "${body.name}" already exists and cannot be replaced` }, 409);
      }
      return c.json({ error: `A tag named "${body.name}" already exists` }, 409);
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

    const [existing] = await database.select().from(tags).where(eq(tags.id, id)).limit(1);
    if (!existing) return c.json({ error: "Tag not found" }, 404);
    if (existing.isBuiltin) return c.json({ error: "Built-in tags cannot be modified" }, 403);

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

    const [existing] = await database.select().from(tags).where(eq(tags.id, id)).limit(1);
    if (!existing) return c.json({ error: "Tag not found" }, 404);
    if (existing.isBuiltin) return c.json({ error: "Built-in tags cannot be deleted" }, 403);

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

    // Prevent merging (deleting) built-in tags
    const builtinSources = await database
      .select({ id: tags.id, name: tags.name, isBuiltin: tags.isBuiltin })
      .from(tags)
      .where(inArray(tags.id, toMerge));
    const builtinBlocked = builtinSources.filter((t) => t.isBuiltin);
    if (builtinBlocked.length > 0) {
      return c.json({ error: `Built-in tags cannot be merged away: ${builtinBlocked.map((t) => t.name).join(", ")}` }, 403);
    }

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
