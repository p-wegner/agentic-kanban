import { workspaces } from "@agentic-kanban/shared/schema";
import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import type { Database } from "../db/index.js";

/** Persist a post-merge cleanup warning on the workspace, keeping its workingDir set. */
export async function persistWorkspaceCleanupWarning(
  workspaceId: string,
  cleanupWarning: string,
  workingDir: string,
  database: Database = db,
): Promise<void> {
  await database.update(workspaces)
    .set({ cleanupWarning, workingDir, updatedAt: new Date().toISOString() })
    .where(eq(workspaces.id, workspaceId));
}

/** Fetch a single workspace row by id, or null if not found. */
export async function getWorkspaceById(
  workspaceId: string,
  database: Database = db,
) {
  return database.select().from(workspaces).where(eq(workspaces.id, workspaceId)).limit(1).then((r) => r[0]);
}
