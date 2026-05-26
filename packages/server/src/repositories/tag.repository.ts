import { tags, issueTags } from "@agentic-kanban/shared/schema";
import { eq, inArray } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { db } from "../db/index.js";
import type { Database } from "../db/index.js";

export async function getAllTags(database: Database = db) {
  return database.select().from(tags);
}

export async function createTag(
  name: string,
  color: string | null,
  database: Database = db,
) {
  const id = randomUUID();
  await database.insert(tags).values({
    id,
    name,
    color: color ?? null,
    createdAt: new Date().toISOString(),
  });
  return { id, name, color: color ?? null };
}

export async function getTagById(
  id: string,
  database: Database = db,
) {
  const rows = await database.select().from(tags).where(eq(tags.id, id)).limit(1);
  return rows[0] ?? null;
}

export async function updateTag(
  id: string,
  updates: Record<string, unknown>,
  database: Database = db,
) {
  await database.update(tags).set(updates).where(eq(tags.id, id));
}

export async function deleteTag(
  id: string,
  database: Database = db,
) {
  await database.delete(issueTags).where(eq(issueTags.tagId, id));
  await database.delete(tags).where(eq(tags.id, id));
}

export async function getTagsByIds(
  ids: string[],
  database: Database = db,
) {
  return database
    .select({ id: tags.id, name: tags.name, isBuiltin: tags.isBuiltin })
    .from(tags)
    .where(inArray(tags.id, ids));
}

export async function getIssueIdsWithTag(
  tagId: string,
  database: Database = db,
) {
  return database
    .select({ issueId: issueTags.issueId })
    .from(issueTags)
    .where(eq(issueTags.tagId, tagId));
}

export async function addIssueTagEntries(
  entries: { id: string; issueId: string; tagId: string }[],
  database: Database = db,
) {
  await database.insert(issueTags).values(entries);
}

export async function removeIssueTagsByTagIds(
  tagIds: string[],
  database: Database = db,
) {
  await database.delete(issueTags).where(inArray(issueTags.tagId, tagIds));
}

export async function deleteTagsByIds(
  ids: string[],
  database: Database = db,
) {
  await database.delete(tags).where(inArray(tags.id, ids));
}

export async function getIssueIdsByTagIds(
  tagIds: string[],
  database: Database = db,
) {
  return database
    .select({ issueId: issueTags.issueId })
    .from(issueTags)
    .where(inArray(issueTags.tagId, tagIds));
}
