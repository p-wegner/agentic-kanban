import { eq } from "drizzle-orm";
import * as schema from "../../schema/index.js";
import type { WorkflowDb } from "./types.js";
import { syncCurrentNodeToStatus } from "./status-sync.js";

export interface TransitionIssueStatusOpts {
  /** Timestamp to stamp on updatedAt/statusChangedAt (defaults to now). */
  now?: string;
}

/**
 * #953 — the SINGLE issue-status transition authority.
 *
 * Every issue-status write must go through here so the three concerns can never
 * drift apart again (the #537 re-break class: raw `update(issues).set({statusId})`
 * writers that skipped workflow-node sync left `currentNodeId` pointing at a
 * non-end node, so dependency resolution's end-node check silently failed):
 *  (a) writes `statusId`,
 *  (b) syncs the workflow current-node to the new status (best-effort, logged —
 *      matching the dominant pre-existing call pattern; a sync failure must not
 *      roll back the status write),
 *  (c) stamps `statusChangedAt` + `updatedAt`.
 *
 * Raw writers outside this module are gated by
 * `packages/server/src/__tests__/status-write-ratchet.test.ts`.
 */
export async function transitionIssueStatus(
  db: WorkflowDb,
  issueId: string,
  statusId: string,
  opts: TransitionIssueStatusOpts = {},
): Promise<void> {
  const now = opts.now ?? new Date().toISOString();
  await db
    .update(schema.issues)
    .set({ statusId, updatedAt: now, statusChangedAt: now })
    .where(eq(schema.issues.id, issueId));
  await syncCurrentNodeToStatus(db, issueId).catch((err) =>
    console.warn(
      `[status-transition] syncCurrentNodeToStatus failed for issue ${issueId} (non-fatal):`,
      err instanceof Error ? err.message : String(err),
    ),
  );
}
