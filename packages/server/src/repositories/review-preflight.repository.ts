import { eq } from "drizzle-orm";
import { workspaceReviewPreflight, workspaces } from "@agentic-kanban/shared/schema";
import { db } from "../db/index.js";
import type { Database } from "../db/index.js";

/**
 * The one owner of review-preflight backoff persistence (#283), over its own table (#798).
 *
 * The four `review_preflight_*` columns used to sit on `workspaces` (81 columns after #781,
 * eleven concerns flattened into one row, measured in #739). This family is the second to be
 * extracted, and unlike `merge_backoff_*` it had no repository at all — the reconciler wrote
 * the columns inline on a live startup path. The seam is half the point of the change.
 *
 * `workspace_review_preflight` holds at most one row per workspace, and only for a workspace
 * that is actually blocked: the block is written lazily on the first failure and DELETED when
 * it clears, so "no row" is the cleared state rather than a special case.
 */

/** The backoff state the reconciler evaluates before spending a rebase on a workspace. */
export interface ReviewPreflightBlock {
  failures: number;
  error: string | null;
  signature: string | null;
  blockedAt: string | null;
}

/**
 * Read one workspace's block.
 *
 * LEFT JOINs from `workspaces` deliberately, the same way `merge-backoff.repository.ts` does:
 * "this workspace has no block" (`failures: 0`) and "there is no such workspace"
 * (`undefined`) are different answers, and they were distinct for free while the columns
 * lived on the row. Selecting straight from `workspace_review_preflight` would collapse them.
 */
export async function getReviewPreflightBlock(
  workspaceId: string,
  database: Database = db,
): Promise<ReviewPreflightBlock | undefined> {
  const [row] = await database.select({
    failures: workspaceReviewPreflight.failures,
    error: workspaceReviewPreflight.error,
    signature: workspaceReviewPreflight.signature,
    blockedAt: workspaceReviewPreflight.blockedAt,
  })
    .from(workspaces)
    .leftJoin(workspaceReviewPreflight, eq(workspaceReviewPreflight.workspaceId, workspaces.id))
    .where(eq(workspaces.id, workspaceId))
    .limit(1);
  if (!row) return undefined;
  // No row = the pre-#798 all-defaults state, not "unknown workspace".
  return { ...row, failures: row.failures ?? 0 };
}

/**
 * Drop the block. Deleting the row IS the cleared state — the reads reconstruct
 * `failures: 0` with everything else null from a missing row, which is exactly what the four
 * columns used to hold after a clear.
 */
export async function clearReviewPreflightBlockRow(
  workspaceId: string,
  database: Database = db,
): Promise<void> {
  await database.delete(workspaceReviewPreflight).where(eq(workspaceReviewPreflight.workspaceId, workspaceId));
}

/** Record (or update) the block after a failed preflight. */
export async function setReviewPreflightBlock(
  workspaceId: string,
  state: { failures: number; error: string; signature: string; blockedAt: string | null },
  database: Database = db,
): Promise<void> {
  const values = {
    workspaceId,
    failures: state.failures,
    error: state.error,
    signature: state.signature,
    blockedAt: state.blockedAt,
  };
  await database.insert(workspaceReviewPreflight).values(values).onConflictDoUpdate({
    target: workspaceReviewPreflight.workspaceId,
    set: {
      failures: values.failures,
      error: values.error,
      signature: values.signature,
      blockedAt: values.blockedAt,
    },
  });
}
