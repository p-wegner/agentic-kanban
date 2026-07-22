import { diffComments } from "@agentic-kanban/shared/schema";
import { eq, and } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { db } from "../../db/index.js";
import type { Database } from "../../db/index.js";

export async function getDiffComments(
  workspaceId: string,
  filePath?: string,
  database: Database = db,
) {
  const conditions = [eq(diffComments.workspaceId, workspaceId)];
  if (filePath) {
    conditions.push(eq(diffComments.filePath, filePath));
  }
  return database
    .select()
    .from(diffComments)
    .where(and(...conditions));
}

export async function createDiffComment(
  workspaceId: string,
  body: { filePath: string; body: string; lineNumOld?: number | null; lineNumNew?: number | null; side?: string },
  database: Database = db,
) {
  const now = new Date().toISOString();
  const comment = {
    id: randomUUID(),
    workspaceId,
    filePath: body.filePath,
    lineNumOld: body.lineNumOld ?? null,
    lineNumNew: body.lineNumNew ?? null,
    side: body.side || "new",
    body: body.body,
    resolvedAt: null as string | null,
    createdAt: now,
    updatedAt: now,
  };

  await database.insert(diffComments).values(comment);
  return comment;
}

export async function setDiffCommentResolved(
  commentId: string,
  resolved: boolean,
  database: Database = db,
) {
  const now = new Date().toISOString();
  await database
    .update(diffComments)
    .set({ resolvedAt: resolved ? now : null, updatedAt: now })
    .where(eq(diffComments.id, commentId));
}

export async function updateDiffComment(
  commentId: string,
  body: string,
  database: Database = db,
) {
  const now = new Date().toISOString();
  await database
    .update(diffComments)
    .set({ body, updatedAt: now })
    .where(eq(diffComments.id, commentId));
}

export async function findDiffComment(
  commentId: string,
  workspaceId: string,
  database: Database = db,
) {
  const rows = await database
    .select()
    .from(diffComments)
    .where(and(eq(diffComments.id, commentId), eq(diffComments.workspaceId, workspaceId)))
    .limit(1);
  return rows[0] ?? null;
}

export async function deleteDiffComment(commentId: string, database: Database = db) {
  await database.delete(diffComments).where(eq(diffComments.id, commentId));
}
