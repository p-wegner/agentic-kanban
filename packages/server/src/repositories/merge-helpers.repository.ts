import { eq } from "drizzle-orm";
import { sessions } from "@agentic-kanban/shared/schema";
import { db } from "../db/index.js";
import type { Database } from "../db/index.js";

/** Returns the status of a single session, or null if it does not exist. */
export async function getSessionStatus(
  sessionId: string,
  database: Database = db,
): Promise<string | null> {
  const sessRows = await database
    .select({ status: sessions.status })
    .from(sessions)
    .where(eq(sessions.id, sessionId))
    .limit(1);
  return sessRows.length > 0 ? sessRows[0].status : null;
}
