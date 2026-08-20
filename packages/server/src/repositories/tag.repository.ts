import { tags, issueTags } from "@agentic-kanban/shared/schema";
import { and, eq, inArray, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { db } from "../db/index.js";
import type { Database } from "../db/index.js";

export async function getAllTags(database: Database = db) {
  return database.select().from(tags);
}

export async function findTagByName(
  name: string,
  database: Database = db,
) {
  const rows = await database.select().from(tags).where(sql`lower(${tags.name}) = lower(${name})`).limit(1);
  return rows[0] ?? null;
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

/**
 * An issue's tag links, name included (#629/#633).
 *
 * Lives here, not in `repo-tags.service`: a service reaching for drizzle directly is the
 * `services-bypass-repositories` violation `pnpm lint:arch` enforces. And here rather than in
 * `issue-ai.repository`, which is already grandfathered at the cohesion ceiling — this file
 * already owns `issueTags`, so it is the cohesive home anyway.
 */
export async function getIssueTagRows(
  issueId: string,
  database: Database = db,
): Promise<{ tagId: string; name: string }[]> {
  return database
    .select({ tagId: tags.id, name: tags.name })
    .from(issueTags)
    .innerJoin(tags, eq(issueTags.tagId, tags.id))
    .where(eq(issueTags.issueId, issueId));
}

/**
 * Unlink specific tags from ONE issue.
 *
 * Scoped to the issue on purpose — contrast {@link removeIssueTagsByTagIds}, which unlinks by
 * tag across every issue. Tag rows are global, so an issue-blind delete here would strip a
 * `repo:<name>` tag from every other issue that shares it.
 */
export async function deleteIssueTagLinks(
  issueId: string,
  tagIds: string[],
  database: Database = db,
): Promise<void> {
  if (tagIds.length === 0) return;
  await database.delete(issueTags).where(and(eq(issueTags.issueId, issueId), inArray(issueTags.tagId, tagIds)));
}
