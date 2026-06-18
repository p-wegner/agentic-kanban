import { failurePatterns, sessionMessages } from "@agentic-kanban/shared/schema";
import { eq, desc } from "drizzle-orm";
import { db } from "../db/index.js";
import type { Database } from "../db/index.js";

export async function findPatternBySourceRef(
  sourceRef: string,
  database: Database = db,
): Promise<{ id: string }[]> {
  return database
    .select({ id: failurePatterns.id })
    .from(failurePatterns)
    .where(eq(failurePatterns.sourceRef, sourceRef))
    .limit(1);
}

export async function insertFailurePattern(
  values: typeof failurePatterns.$inferInsert,
  database: Database = db,
): Promise<void> {
  await database.insert(failurePatterns).values(values);
}

export async function getAllFailurePatterns(database: Database = db) {
  return database.select().from(failurePatterns);
}

export async function getSessionMessageTypesAndData(
  sessionId: string,
  limit: number,
  database: Database = db,
): Promise<Array<{ type: string; data: string | null }>> {
  return database
    .select({ type: sessionMessages.type, data: sessionMessages.data })
    .from(sessionMessages)
    .where(eq(sessionMessages.sessionId, sessionId))
    .orderBy(desc(sessionMessages.id))
    .limit(limit);
}

export async function deleteFailurePattern(
  id: string,
  database: Database = db,
): Promise<void> {
  await database.delete(failurePatterns).where(eq(failurePatterns.id, id));
}
