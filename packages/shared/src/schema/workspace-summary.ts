import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";
import { relations } from "drizzle-orm";
import { workspaces } from "./workspaces.js";

/**
 * The workspace-summary GIT PROJECTION, extracted out of `workspaces` (#815, the eighth
 * family after `merge_backoff_*` in #781, `review_preflight_*` / `code_metrics_*` /
 * `latest_symlink_*` in #798, and `merge_gate_*` / `conflict_cache_*` / `latest_setup_*`).
 *
 * #399 (decision 014): the two phase-4 git facts (`git log -1` sha+subject and
 * `git rev-list --count base..HEAD`) persisted per workspace so board reads never spawn git
 * on the hot path, plus the freshness stamp and the dirty flag that drive the SWR refresh.
 * `head_message` is a free-text commit subject — exactly the fat column the board's own
 * comments describe its hot queries as skipping — and the other four are pure derived cache.
 *
 * ## The inversion this family carries, and how it is resolved
 *
 * Unlike the seven landed families, an ABSENT ROW HERE IS NOT THE NEUTRAL VALUE. The dropped
 * `summary_dirty` column was `NOT NULL DEFAULT TRUE`, so a workspace that has never been
 * projected is DIRTY, not clean. Every read therefore coalesces a missing row to
 * `dirty = true` (and to NULL facts / NULL stamp), which is the same answer the column gave a
 * freshly-inserted row. Concretely:
 *
 *  - `fetchWorkspaceDetailRows` LEFT JOINs and selects `coalesce(dirty, 1)`;
 *  - `selectSummaryHealCandidates` LEFT JOINs, and both its WHERE and its ORDER BY coalesce —
 *    the WHERE would have picked the row up anyway via `git_refreshed_at IS NULL`, but SQLite
 *    sorts NULL LAST under DESC, so an un-coalesced `ORDER BY dirty DESC` would have ranked
 *    never-projected workspaces BELOW dirty ones instead of alongside them.
 *
 * That is why the write side never needs an upsert for the dirty flag: `markSummaryDirty` is a
 * plain UPDATE, and a workspace with no row is a no-op that is ALREADY dirty by absence. The
 * only writer that must insert is the write-through refresh, which is the only thing that can
 * make a projection clean — so it upserts.
 *
 * ## The parallel projection on `repos` deliberately stays inline
 *
 * `repos` carries its own `summary_*` block (`summary_ahead`, `summary_historic`,
 * `summary_git_refreshed_at`, `summary_dirty`, migration 0118) and
 * `workspace-summary-projection.{repository,service}.ts` handle both halves. They are NOT one
 * mechanism with two backing stores: the column sets differ, the freshness predicates differ
 * (`isGitProjectionFresh` vs `isRepoProjectionFresh`), and each half has its own heal pass and
 * its own candidate query. `repos` is 23 columns wide with no width ratchet on it, so it is
 * not the table this extraction exists to relieve; moving it too would be a second, unrelated
 * schema change smuggled into this one.
 *
 * `onDelete: "cascade"`, so the projection dies with its workspace; the FK's leading index is
 * the primary key's own automatic index (#740).
 */
export const workspaceSummary = sqliteTable("workspace_summary", {
  /** The workspace this projection belongs to. PK: one projection per workspace. */
  workspaceId: text("workspace_id")
    .primaryKey()
    .references(() => workspaces.id, { onDelete: "cascade" }),
  /** `git log -1` sha of the worktree HEAD at the last refresh. */
  headSha: text("head_sha"),
  /** Subject line of that commit. Free text — the reason this block is worth moving. */
  headMessage: text("head_message"),
  /** `git rev-list --count base..HEAD`. Null for a direct workspace or an unknown base. */
  commitCount: integer("commit_count"),
  /** Per-row staleness stamp; NULL (or no row) means never projected. */
  gitRefreshedAt: text("git_refreshed_at"),
  /**
   * Set by board events (status transitions, merge stamps, update-base), cleared by the
   * write-through refresh. `NOT NULL DEFAULT TRUE` exactly as the dropped column was — and a
   * MISSING ROW means dirty too, which is what every read coalesces to.
   */
  dirty: integer("dirty", { mode: "boolean" }).notNull().default(true),
});

export const workspaceSummaryRelations = relations(workspaceSummary, ({ one }) => ({
  workspace: one(workspaces, {
    fields: [workspaceSummary.workspaceId],
    references: [workspaces.id],
  }),
}));
