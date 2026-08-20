import { eq } from "drizzle-orm";
import { workspaces } from "@agentic-kanban/shared/schema";
import { db } from "../db/index.js";
import type { Database } from "../db/index.js";
import { getAllPreferences as canonicalGetAllPreferences } from "./preferences.repository.js";

/** #613: delegates to the canonical reader — see preferences.repository. */
export async function getAllPreferences(database: Database = db) {
  return canonicalGetAllPreferences(database);
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
