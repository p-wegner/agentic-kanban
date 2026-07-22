import { eq } from "drizzle-orm";
import { workspaces } from "@agentic-kanban/shared/schema";
import { db } from "../db/index.js";
import type { Database } from "../db/index.js";

/** Stamp mergedAt/mergedHeadSha/updatedAt on a workspace row. */
export async function stampWorkspaceMergedAt(
  id: string,
  now: string,
  mergedHeadSha: string | null,
  database: Database = db,
): Promise<void> {
  await database.update(workspaces).set({ mergedAt: now, mergedHeadSha, updatedAt: now }).where(eq(workspaces.id, id));
}

/**
 * Stamp ONLY mergedHeadSha (+updatedAt) on a workspace row, leaving mergedAt untouched.
 * Used by the reconcile-as-done close path (#115) which sets mergedAt separately via
 * closeWorkspace/finalizeMergeCleanup and only needs to record the landed leading tip.
 */
export async function stampWorkspaceMergedHeadSha(
  id: string,
  mergedHeadSha: string,
  now: string,
  database: Database = db,
): Promise<void> {
  await database.update(workspaces).set({ mergedHeadSha, updatedAt: now }).where(eq(workspaces.id, id));
}
