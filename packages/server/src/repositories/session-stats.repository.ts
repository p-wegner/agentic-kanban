import { sessions } from "@agentic-kanban/shared/schema";
import { inArray } from "drizzle-orm";
import { db } from "../db/index.js";
import type { Database } from "../db/index.js";

/**
 * Latest-first session rows (id, workspaceId, stats) for a set of workspace IDs,
 * ordered by startedAt so the caller can keep the last one per workspace.
 */
export async function getSessionStatsByWorkspaceIds(
  wsIds: string[],
  database: Database = db,
) {
  return database
    .select({ id: sessions.id, workspaceId: sessions.workspaceId, stats: sessions.stats })
    .from(sessions)
    .where(inArray(sessions.workspaceId, wsIds))
    .orderBy(sessions.startedAt);
}
