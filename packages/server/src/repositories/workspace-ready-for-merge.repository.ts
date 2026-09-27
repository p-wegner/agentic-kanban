import { eq, inArray } from "drizzle-orm";
import { workspaceReadyForMerge } from "@agentic-kanban/shared/schema";
import { db } from "../db/index.js";
import type { Database } from "../db/index.js";

/**
 * The one owner of `workspace_ready_for_merge` persistence (#1253, #1246 follow-up) — the
 * moment a workspace became ready-for-merge, read by `getQueuePressureMemberRows` instead of
 * `workspaces.updatedAt`. See the schema module header for why a dedicated table.
 *
 * Every production call site that sets `readyForMerge: true` on `workspaces` must call
 * `stampWorkspaceReadyForMergeAt` alongside it, and every site that sets it back to `false`
 * must call `clearWorkspaceReadyForMergeAt`.
 */
export async function stampWorkspaceReadyForMergeAt(
  workspaceId: string,
  readySince: string,
  database: Database = db,
): Promise<void> {
  await database.insert(workspaceReadyForMerge).values({ workspaceId, readySince })
    .onConflictDoUpdate({ target: workspaceReadyForMerge.workspaceId, set: { readySince } });
}

export async function clearWorkspaceReadyForMergeAt(
  workspaceId: string,
  database: Database = db,
): Promise<void> {
  await database.delete(workspaceReadyForMerge).where(eq(workspaceReadyForMerge.workspaceId, workspaceId));
}

/** The stamped readySince for one workspace, or `undefined` if it was never stamped. */
export async function getWorkspaceReadyForMergeAt(
  workspaceId: string,
  database: Database = db,
): Promise<string | undefined> {
  const [row] = await database.select({ readySince: workspaceReadyForMerge.readySince })
    .from(workspaceReadyForMerge)
    .where(eq(workspaceReadyForMerge.workspaceId, workspaceId))
    .limit(1);
  return row?.readySince;
}

/** Batch form of `getWorkspaceReadyForMergeAt`, keyed by workspace id. */
export async function getWorkspaceReadyForMergeAtBatch(
  workspaceIds: string[],
  database: Database = db,
): Promise<Map<string, string>> {
  if (workspaceIds.length === 0) return new Map();
  const rows = await database.select({ workspaceId: workspaceReadyForMerge.workspaceId, readySince: workspaceReadyForMerge.readySince })
    .from(workspaceReadyForMerge)
    .where(inArray(workspaceReadyForMerge.workspaceId, workspaceIds));
  return new Map(rows.map((r) => [r.workspaceId, r.readySince]));
}
