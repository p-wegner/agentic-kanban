import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";
import { relations } from "drizzle-orm";
import { workspaces } from "./workspaces.js";

/**
 * Merge-backoff state, extracted out of `workspaces` (#781, the remainder of #739).
 *
 * `workspaces` carried 88 columns — not one entity, but eleven concerns flattened into one
 * row by prefix. `merge_backoff_*` was seven of them, and the first family extracted: it is
 * the largest family with the smallest blast radius, because every read and write already
 * went through one repository (`merge-backoff.repository.ts`) whose only consumer is
 * `merge-backoff.service.ts`. Nothing outside that repository ever named these columns.
 *
 * ONE row per workspace, written lazily on the first merge failure and DELETED when the
 * block clears — so the common case (a workspace that never failed a merge) now stores
 * nothing at all, where before it paid seven columns on the board's hottest table.
 *
 * The reads deliberately LEFT JOIN from `workspaces`: the service distinguishes "this
 * workspace does not exist" (record nothing) from "no backoff yet" (failures 0), and that
 * distinction used to fall out of the columns living on the row itself. See
 * `merge-backoff.repository.ts` — the join is what preserves it.
 *
 * `onDelete: "cascade"`, so the row dies with its workspace; the FK's leading index is the
 * primary key's own automatic index (#740).
 */
export const workspaceMergeBackoff = sqliteTable("workspace_merge_backoff", {
  /** The workspace this backoff belongs to. PK: at most one live block per workspace. */
  workspaceId: text("workspace_id")
    .primaryKey()
    .references(() => workspaces.id, { onDelete: "cascade" }),
  /** Consecutive failures with the CURRENT signature. */
  failures: integer("failures").notNull().default(0),
  /** `<failureClass>|<messageDigest>` — identity of the failing attempt. */
  signature: text("signature"),
  /** The last merge failure message, so the block is explainable without the log. */
  error: text("error"),
  /** Branch tip observed at the last failure — a moved tip voids the block. */
  branchSha: text("branch_sha"),
  /** Hash of the project's verify_script at the last failure — changed content voids the block. */
  verifyHash: text("verify_hash"),
  /** No merge retry for this workspace before this instant (ISO). */
  nextRetryAt: text("next_retry_at"),
  /** When the CURRENT failure signature was first observed — the "blocked since" for warnings. */
  since: text("since"),
});

export const workspaceMergeBackoffRelations = relations(workspaceMergeBackoff, ({ one }) => ({
  workspace: one(workspaces, {
    fields: [workspaceMergeBackoff.workspaceId],
    references: [workspaces.id],
  }),
}));
