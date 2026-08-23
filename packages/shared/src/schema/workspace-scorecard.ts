import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";
import { relations } from "drizzle-orm";
import { workspaces } from "./workspaces.js";

/**
 * The computed PR-quality SCORECARD for a workspace, extracted out of `workspaces` (#815, the
 * tenth and last family in scope, after `merge_backoff_*` in #781, `review_preflight_*` /
 * `code_metrics_*` / `latest_symlink_*` in #798, and `merge_gate_*` / `conflict_cache_*` /
 * `latest_setup_*` / `summary_*` / `diff_stat_cache_*`).
 *
 * This is a computed ARTIFACT, the same shape as `workspace_code_metrics` (#798): a score, the
 * JSON breakdown it was derived from, and the stamp saying when. `scorecard_json` is a
 * free-text blob carrying the whole per-dimension array — exactly the fat column the board's
 * hot queries describe themselves as skipping, and the reason this family was sequenced last
 * rather than dropped.
 *
 * ## Absence is the neutral value
 *
 * All three dropped columns were nullable with no default, and every consumer already
 * branches on `scorecardScore === null` ("not yet computed"). An ABSENT ROW reproduces that
 * exactly, so no read coalesces and none needs `.mapWith(...)` — the LEFT JOIN's own NULLs ARE
 * the previous semantics. `getScorecardScores` (the histogram) keeps filtering on
 * `IS NOT NULL`, which now selects FROM this table directly: a workspace with no row has no
 * score, which is what the filter meant.
 *
 * The LEFT JOIN is load-bearing everywhere else: an inner join would hide every workspace
 * whose first session has not ended yet, which is most of the board at any moment.
 *
 * `onDelete: "cascade"`, so the artifact dies with its workspace; the FK's leading index is
 * the primary key's own automatic index (#740).
 */
export const workspaceScorecard = sqliteTable("workspace_scorecard", {
  /** The workspace this scorecard belongs to. PK: one scorecard per workspace. */
  workspaceId: text("workspace_id")
    .primaryKey()
    .references(() => workspaces.id, { onDelete: "cascade" }),
  /** 0-100 total. NULL/absent = not yet computed. */
  score: integer("score"),
  /** JSON array of `{name, score, maxScore, signal}` dimensions. The fat column. */
  json: text("json"),
  /** When the scorecard was last computed. */
  computedAt: text("computed_at"),
});

export const workspaceScorecardRelations = relations(workspaceScorecard, ({ one }) => ({
  workspace: one(workspaces, {
    fields: [workspaceScorecard.workspaceId],
    references: [workspaces.id],
  }),
}));
