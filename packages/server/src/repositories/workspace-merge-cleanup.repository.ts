import { workspaces } from "@agentic-kanban/shared/schema";
import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import type { Database } from "../db/index.js";
import { mirrorWorkspaceColumnsToLeadingRepo } from "./repo.repository.js";

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
  await mirrorWorkspaceColumnsToLeadingRepo(workspaceId, { workingDir }, database);
}

/** Fetch a single workspace row by id, or null if not found. */
// #502: one definition, in workspace-reads. This copy resolved to `undefined` rather
// than `null` for a miss; its only caller tests truthiness, so both read the same.
export { getWorkspaceById } from "./workspace-reads.repository.js";
