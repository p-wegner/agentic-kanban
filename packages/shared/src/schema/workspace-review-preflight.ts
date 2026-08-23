import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";
import { relations } from "drizzle-orm";
import { workspaces } from "./workspaces.js";

/**
 * Review-preflight backoff state (#283), extracted out of `workspaces` (#798, after #781).
 *
 * The second of the eleven column families #739 counted on `workspaces`, and the cheapest
 * remaining one by coupling: exactly TWO non-test files ever named the four
 * `review_preflight_*` columns — this schema and `startup/stranded-review-reconciler.ts`.
 * (`drive-obstacles.ts` matches the same string only as the obstacle KIND
 * `"review_preflight_conflict"`, never as a column, so #739's count of 2 stands.)
 *
 * Unlike `merge_backoff_*`, this family had no repository at all: the reconciler wrote the
 * columns inline with `database.update(workspaces).set({...})`. The extraction introduces
 * `review-preflight.repository.ts` as the seam, which is the part of the change that is
 * worth having independently of the width.
 *
 * ONE row per workspace, written lazily on the first preflight failure and DELETED when the
 * block clears — so a workspace that never conflicted on rebase stores nothing at all, where
 * before every row paid four columns on the board's hottest table.
 *
 * The reads LEFT JOIN from `workspaces` for the same reason `workspace_merge_backoff` does:
 * "this workspace has no block" (failures 0) and "there is no such workspace" are different
 * answers, and selecting straight from this table collapses them.
 *
 * `onDelete: "cascade"`, so the row dies with its workspace; the FK's leading index is the
 * primary key's own automatic index (#740).
 */
export const workspaceReviewPreflight = sqliteTable("workspace_review_preflight", {
  /** The workspace this block belongs to. PK: at most one live block per workspace. */
  workspaceId: text("workspace_id")
    .primaryKey()
    .references(() => workspaces.id, { onDelete: "cascade" }),
  /** Consecutive preflight failures observed against the CURRENT signature. */
  failures: integer("failures").notNull().default(0),
  /** The last rebase-preflight error message, so the block is explainable without the log. */
  error: text("error"),
  /** `<branchHeadSha>..<baseHeadSha>` the failures above were observed against. */
  signature: text("signature"),
  /** Set when the attempt budget was exhausted for the current signature. */
  blockedAt: text("blocked_at"),
});

export const workspaceReviewPreflightRelations = relations(workspaceReviewPreflight, ({ one }) => ({
  workspace: one(workspaces, {
    fields: [workspaceReviewPreflight.workspaceId],
    references: [workspaces.id],
  }),
}));
