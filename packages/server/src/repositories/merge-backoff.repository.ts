import { eq } from "drizzle-orm";
import { workspaceMergeBackoff, workspaces } from "@agentic-kanban/shared/schema";
import { db } from "../db/index.js";
import type { Database } from "../db/index.js";

/**
 * The one owner of merge-backoff persistence (#417), now over its own table (#781).
 *
 * The seven `merge_backoff_*` columns used to sit on `workspaces` (88 columns — eleven
 * concerns flattened into one row, measured in #739). Nothing outside this file ever named
 * them, which is why this family was extracted first; `workspace_merge_backoff` holds at
 * most one row per workspace and only for a workspace that is actually blocked.
 *
 * The reads LEFT JOIN from `workspaces` rather than selecting from the new table alone, and
 * that is load-bearing, not stylistic: `recordMergeFailure` returns early on `undefined` to
 * mean "no such workspace, record nothing", while a workspace with NO backoff yet must come
 * back as `failures: 0`. When the columns lived on the row those two cases were distinct for
 * free. Selecting from `workspace_merge_backoff` directly would collapse them and silently
 * drop every FIRST merge failure.
 */

/** The backoff columns `shouldSkipMergeForBackoff` reads off a workspace row. */
export interface MergeBackoffRow {
  failures: number | null;
  signature: string | null;
  branchSha: string | null;
  verifyHash: string | null;
  nextRetryAt: string | null;
}

export async function getMergeBackoffState(
  workspaceId: string,
  database: Database = db,
): Promise<MergeBackoffRow | undefined> {
  const [row] = await database.select({
    failures: workspaceMergeBackoff.failures,
    signature: workspaceMergeBackoff.signature,
    branchSha: workspaceMergeBackoff.branchSha,
    verifyHash: workspaceMergeBackoff.verifyHash,
    nextRetryAt: workspaceMergeBackoff.nextRetryAt,
  })
    .from(workspaces)
    .leftJoin(workspaceMergeBackoff, eq(workspaceMergeBackoff.workspaceId, workspaces.id))
    .where(eq(workspaces.id, workspaceId))
    .limit(1);
  if (!row) return undefined;
  // No backoff row = the pre-#781 all-defaults state, not "unknown workspace".
  return { ...row, failures: row.failures ?? 0 };
}

/** The subset `recordMergeFailure` needs to decide whether a failure is a repeat. */
export async function getMergeBackoffSignatureState(
  workspaceId: string,
  database: Database = db,
): Promise<{ failures: number | null; signature: string | null; since: string | null } | undefined> {
  const [row] = await database.select({
    failures: workspaceMergeBackoff.failures,
    signature: workspaceMergeBackoff.signature,
    since: workspaceMergeBackoff.since,
  })
    .from(workspaces)
    .leftJoin(workspaceMergeBackoff, eq(workspaceMergeBackoff.workspaceId, workspaces.id))
    .where(eq(workspaces.id, workspaceId))
    .limit(1);
  if (!row) return undefined;
  return { ...row, failures: row.failures ?? 0 };
}

/**
 * Drop the block. Deleting the row IS the cleared state — the reads reconstruct
 * `failures: 0` with everything else null from a missing row, which is exactly what the
 * seven columns used to hold after a clear.
 */
export async function clearMergeBackoffState(workspaceId: string, database: Database = db): Promise<void> {
  await database.delete(workspaceMergeBackoff).where(eq(workspaceMergeBackoff.workspaceId, workspaceId));
}

export async function setMergeBackoffState(
  workspaceId: string,
  state: {
    failures: number;
    signature: string;
    error: string;
    branchSha: string | null;
    verifyHash: string | null;
    nextRetryAt: string;
    since: string;
    updatedAt: string;
  },
  database: Database = db,
): Promise<void> {
  const values = {
    workspaceId,
    failures: state.failures,
    signature: state.signature,
    error: state.error,
    branchSha: state.branchSha,
    verifyHash: state.verifyHash,
    nextRetryAt: state.nextRetryAt,
    since: state.since,
  };
  await database.insert(workspaceMergeBackoff).values(values).onConflictDoUpdate({
    target: workspaceMergeBackoff.workspaceId,
    set: {
      failures: values.failures,
      signature: values.signature,
      error: values.error,
      branchSha: values.branchSha,
      verifyHash: values.verifyHash,
      nextRetryAt: values.nextRetryAt,
      since: values.since,
    },
  });
  // The write still touches the workspace row: `updatedAt` moving on a recorded merge
  // failure is observable behaviour (staleness/ordering elsewhere reads it), and it was
  // part of the same UPDATE before the extraction.
  await database.update(workspaces)
    .set({ updatedAt: state.updatedAt })
    .where(eq(workspaces.id, workspaceId));
}
