import { sessions } from "@agentic-kanban/shared/schema";
import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import type { Database } from "../db/index.js";

export async function getSessionStats(
  sessionId: string,
  database: Database = db,
) {
  return database.select({ stats: sessions.stats }).from(sessions).where(eq(sessions.id, sessionId)).limit(1);
}
