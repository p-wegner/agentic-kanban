import { sqliteTable, text } from "drizzle-orm/sqlite-core";
import { relations } from "drizzle-orm";
import { workspaces } from "./workspaces.js";

/**
 * The workspace's computed code-metrics artifact, extracted out of `workspaces`
 * (#798, the third family after #781's `merge_backoff_*` and #798's `review_preflight_*`).
 *
 * Two columns, and — measured rather than assumed — only THREE non-test files ever named
 * them: `workspace-code-metrics.repository.ts` (the writer), `workspace-summary.repository.ts`
 * (the read), and the schema. #739 listed this family at 14 files; that count was produced by
 * a substring grep and it counted PROSE. The hits in `mcp-server/src/tools/get-board-status.ts`
 * and `repositories/board-status.repository.ts` are both comments naming `code_metrics_json`
 * as an example of a fat column deliberately NOT selected, and `workspace-summary.service.ts`
 * reads `codeMetricsJson` off the projected row shape, not off the table — so it does not
 * change when the storage does.
 *
 * A computed artifact, so no facade and no dual write: the value is recomputed on a cache
 * miss anyway. One row per workspace, written on the first computation. A workspace whose
 * metrics were never computed stores nothing, where before it paid two columns — one of them
 * a multi-KB JSON blob — on the board's hottest table.
 *
 * The read LEFT JOINs from `workspaces` and aliases back to `codeMetricsJson` /
 * `codeMetricsComputedAt`, so every consumer of the projected row is untouched by the move.
 *
 * `onDelete: "cascade"`, so the row dies with its workspace; the FK's leading index is the
 * primary key's own automatic index (#740).
 */
export const workspaceCodeMetrics = sqliteTable("workspace_code_metrics", {
  /** The workspace these metrics describe. PK: one current artifact per workspace. */
  workspaceId: text("workspace_id")
    .primaryKey()
    .references(() => workspaces.id, { onDelete: "cascade" }),
  /** The serialized metrics artifact. Multi-KB — the reason it does not belong on the row. */
  metricsJson: text("metrics_json"),
  /** When the artifact was computed (ISO). Drives the staleness check that recomputes it. */
  computedAt: text("computed_at"),
});

export const workspaceCodeMetricsRelations = relations(workspaceCodeMetrics, ({ one }) => ({
  workspace: one(workspaces, {
    fields: [workspaceCodeMetrics.workspaceId],
    references: [workspaces.id],
  }),
}));
