import { eq, inArray } from "drizzle-orm";
import * as schema from "../../schema/index.js";
import type { WorkflowDb } from "./types.js";
import { syncCurrentNodeToStatus } from "./status-sync.js";
import {
  checkIssueStatusTransition,
  getTransitionStrictness,
  IllegalStatusTransitionError,
} from "../status-transitions.js";

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

  // Transition-legality observability (arch-review §1.1). Resolve the current
  // and target status NAMES and classify the transition against the canonical
  // legal table. Default policy is WARN-AND-ALLOW (a non-canonical/custom status
  // never warns); STRICT throws. This is best-effort observability and must not
  // change the write behavior under the default policy — a lookup failure is
  // swallowed so a status write is never blocked by the check itself.
  try {
    const currentRows = await db
      .select({ statusId: schema.issues.statusId })
      .from(schema.issues)
      .where(eq(schema.issues.id, issueId))
      .limit(1);
    const fromStatusId = currentRows[0]?.statusId;
    if (fromStatusId && fromStatusId !== statusId) {
      const nameRows = await db
        .select({ id: schema.projectStatuses.id, name: schema.projectStatuses.name })
        .from(schema.projectStatuses)
        .where(inArray(schema.projectStatuses.id, [fromStatusId, statusId]));
      const nameById = new Map(nameRows.map((r) => [r.id, r.name]));
      const fromName = nameById.get(fromStatusId);
      const toName = nameById.get(statusId);
      if (fromName && toName) {
        const check = checkIssueStatusTransition(fromName, toName);
        if (!check.legal) {
          if (getTransitionStrictness() === "strict") {
            throw new IllegalStatusTransitionError(
              `[status-transition] illegal issue transition ${issueId}: ${check.message}`,
            );
          }
          console.warn(
            `[status-transition] illegal issue transition ${issueId} "${fromName}" -> "${toName}" — warn-and-allow (arch-review §1.1; set strictness=strict to enforce)`,
          );
        }
      }
    }
  } catch (err) {
    // A STRICT-policy violation must propagate; anything else (a DB read hiccup)
    // is swallowed so the observability check never blocks a legitimate write.
    if (err instanceof IllegalStatusTransitionError) throw err;
    console.warn(
      `[status-transition] transition-legality check failed for issue ${issueId} (non-fatal):`,
      err instanceof Error ? err.message : String(err),
    );
  }

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
