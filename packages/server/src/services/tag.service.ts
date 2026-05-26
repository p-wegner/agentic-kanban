import { randomUUID } from "node:crypto";
import { db } from "../db/index.js";
import type { Database } from "../db/index.js";
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

export class TagError extends Error {
  constructor(
    message: string,
    public readonly code: "NOT_FOUND" | "BAD_REQUEST" | "FORBIDDEN",
  ) {
    super(message);
  }
}

export function createTagService({ database }: { database: Database }) {
  async function listTags() {
    return getAllTags(database);
  }

  async function createNewTag(name: string, color: string | null) {
    return createTag(name, color, database);
  }

  async function updateTagById(id: string, updates: { name?: string; color?: string }) {
    const existing = await getTagById(id, database);
    if (!existing) throw new TagError("Tag not found", "NOT_FOUND");
    if (existing.isBuiltin) throw new TagError("Built-in tags cannot be modified", "FORBIDDEN");

    const fields: Record<string, unknown> = {};
    if (updates.name !== undefined) fields.name = updates.name;
    if (updates.color !== undefined) fields.color = updates.color;

    if (Object.keys(fields).length === 0) {
      throw new TagError("No fields to update", "BAD_REQUEST");
    }

    await updateTag(id, fields, database);
    return { id };
  }

  async function deleteTagById(id: string) {
    const existing = await getTagById(id, database);
    if (!existing) throw new TagError("Tag not found", "NOT_FOUND");
    if (existing.isBuiltin) throw new TagError("Built-in tags cannot be deleted", "FORBIDDEN");

    await deleteTag(id, database);
  }

  async function mergeTags(targetId: string, sourceIds: string[]) {
    const toMerge = sourceIds.filter((id) => id !== targetId);
    if (toMerge.length === 0) return { merged: 0 };

    const builtinSources = await getTagsByIds(toMerge, database);
    const builtinBlocked = builtinSources.filter((t) => t.isBuiltin);
    if (builtinBlocked.length > 0) {
      throw new TagError(
        `Built-in tags cannot be merged away: ${builtinBlocked.map((t) => t.name).join(", ")}`,
        "FORBIDDEN",
      );
    }

    const existing = await getIssueIdsWithTag(targetId, database);
    const alreadyTagged = new Set(existing.map((r) => r.issueId));

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

    await removeIssueTagsByTagIds(toMerge, database);
    await deleteTagsByIds(toMerge, database);

    return { merged: toMerge.length };
  }

  return { listTags, createNewTag, updateTagById, deleteTagById, mergeTags };
}

export const tagService = createTagService({ database: db });
