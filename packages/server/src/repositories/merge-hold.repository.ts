import { eq, inArray } from "drizzle-orm";
import { workspaceMergeHold } from "@agentic-kanban/shared/schema";
import { db } from "../db/index.js";
import type { Database } from "../db/index.js";

/**
 * The one owner of merge-hold persistence (#1164) — same shape as `merge-backoff.repository.ts`.
 *
 * ONE row per workspace, present only while held. "No row" means "not held"; nothing else reads
 * or writes `workspace_merge_hold` directly.
 */

export interface MergeHoldRow {
  workspaceId: string;
  reason: string | null;
  heldAt: string;
}

export async function getMergeHold(workspaceId: string, database: Database = db): Promise<MergeHoldRow | undefined> {
  const [row] = await database.select()
    .from(workspaceMergeHold)
    .where(eq(workspaceMergeHold.workspaceId, workspaceId))
    .limit(1);
  return row;
}

/** Every currently-held workspace id, for the three per-cycle callers that must skip them. */
export async function getHeldWorkspaceIds(database: Database = db): Promise<Set<string>> {
  const rows = await database.select({ workspaceId: workspaceMergeHold.workspaceId }).from(workspaceMergeHold);
  return new Set(rows.map((r) => r.workspaceId));
}

/** Which of the given workspace ids are currently held — for the merge-train reconciler's member-set check. */
export async function getHeldWorkspaceIdsAmong(workspaceIds: string[], database: Database = db): Promise<Set<string>> {
  if (workspaceIds.length === 0) return new Set();
  const rows = await database.select({ workspaceId: workspaceMergeHold.workspaceId })
    .from(workspaceMergeHold)
    .where(inArray(workspaceMergeHold.workspaceId, workspaceIds));
  return new Set(rows.map((r) => r.workspaceId));
}

export async function setMergeHold(
  workspaceId: string,
  input: { reason: string | null; heldAt: string },
  database: Database = db,
): Promise<void> {
  await database.insert(workspaceMergeHold).values({ workspaceId, reason: input.reason, heldAt: input.heldAt })
    .onConflictDoUpdate({
      target: workspaceMergeHold.workspaceId,
      set: { reason: input.reason, heldAt: input.heldAt },
    });
}

/** Release the hold. A no-op (not an error) when the workspace was not held. */
export async function clearMergeHold(workspaceId: string, database: Database = db): Promise<void> {
  await database.delete(workspaceMergeHold).where(eq(workspaceMergeHold.workspaceId, workspaceId));
}
