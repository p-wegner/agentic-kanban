import { eq } from "drizzle-orm";
import { preferences, workspaces } from "@agentic-kanban/shared/schema";
import { db } from "../db/index.js";
import type { Database } from "../db/index.js";

export async function getAllPreferences(database: Database = db) {
  return database.select().from(preferences);
}

export async function clearWorkspaceReadyForMerge(
  workspaceId: string,
  updatedAt: string,
  database: Database = db,
): Promise<void> {
  await database
    .update(workspaces)
    .set({ readyForMerge: false, updatedAt })
    .where(eq(workspaces.id, workspaceId));
}
