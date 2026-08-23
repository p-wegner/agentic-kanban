import { sqliteTable, text } from "drizzle-orm/sqlite-core";
import { relations } from "drizzle-orm";
import { workspaces } from "./workspaces.js";

/**
 * The dependency-symlink bootstrap run for a workspace, extracted out of `workspaces`
 * (#798, the fourth family after `merge_backoff_*`, `review_preflight_*`, `code_metrics_*`).
 *
 * **This family carried #798's one open question — extract, or RETIRE?** Dependency Symlinks
 * is off by default (the board moved to install-per-worktree), so the eight columns look like
 * a legacy feature paying rent on every row. Answered: EXTRACT. The feature is live, not
 * legacy — `projects.symlinkEnabled` / `symlinkDirs` are a per-project setting with UI
 * (`ProjectSettings.tsx`), `workspace-provision.service.ts` calls `bootstrapSymlinks` when it
 * is on, and `WorkspaceDiagnosticsPanel.tsx` renders exactly this run record. "Off by
 * default" is a statement about how projects are configured, i.e. the same class of evidence
 * as #739's twelve always-NULL columns: a usage fact, not a schema fact. Retiring it would
 * delete a working opt-in.
 *
 * ONE row per workspace, written at creation alongside the workspace itself — including the
 * `state: "disabled"` run for a project with the feature off, because that is exactly what
 * the columns held and the diagnostics panel distinguishes "disabled" from "pending". So the
 * saving here is table width and hot-row size, not row count; that is still the point, since
 * eight of these are text/JSON columns nothing on the board's read path wants.
 *
 * `onDelete: "cascade"`, so the row dies with its workspace; the FK's leading index is the
 * primary key's own automatic index (#740).
 */
export const workspaceSymlinkRun = sqliteTable("workspace_symlink_run", {
  /** The workspace this run belongs to. PK: one bootstrap run per workspace. */
  workspaceId: text("workspace_id")
    .primaryKey()
    .references(() => workspaces.id, { onDelete: "cascade" }),
  /** `disabled` | `skipped` | `success` | `failed` | `error` — see `workspace-run-records.ts`. */
  state: text("state"),
  startedAt: text("started_at"),
  endedAt: text("ended_at"),
  /** JSON array: the directories the project asked to have symlinked. */
  dirs: text("dirs"),
  /** JSON array: the directories actually linked. */
  linked: text("linked"),
  /** JSON array: the directories skipped (already present, or nothing to link). */
  skipped: text("skipped"),
  /** JSON array of `{ dir, error }`: the directories that failed to link. */
  failed: text("failed"),
  /** Set when the bootstrap threw outright rather than failing per directory. */
  error: text("error"),
});

export const workspaceSymlinkRunRelations = relations(workspaceSymlinkRun, ({ one }) => ({
  workspace: one(workspaces, {
    fields: [workspaceSymlinkRun.workspaceId],
    references: [workspaces.id],
  }),
}));
