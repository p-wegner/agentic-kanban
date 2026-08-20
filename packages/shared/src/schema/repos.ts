import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { workspaces } from "./workspaces.js";
import { projects } from "./projects.js";

/**
 * Multi-repo projects (full-peers model). Two kinds of rows share this table:
 * - project-scoped (`projectId` set, `workspaceId` NULL): an ADDITIONAL repo of the
 *   project. The leading repo stays on `projects.repoPath` — single-repo projects
 *   have zero rows here and take the exact legacy code paths.
 * - workspace-scoped (`workspaceId` set): the per-workspace worktree record for one
 *   additional repo (worktreePath/branch/baseBranch/baseCommitSha, mergedHeadSha
 *   stamped on merge).
 */
export const repos = sqliteTable("repos", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").references(() => workspaces.id),
  projectId: text("project_id").references(() => projects.id),
  path: text("path").notNull(),
  name: text("name"),
  scripts: text("scripts"),
  // Per-repo setup/install command (#71). Runs in this repo's worktree at workspace
  // creation, in addition to the project-level (leading-repo) setup_script. NULL = none.
  setupScript: text("setup_script"),
  // Optional compose file (relative to this repo) whose services compose into the
  // workspace stack alongside the project's configured stack (#71). NULL = none.
  composeFile: text("compose_file"),
  defaultBranch: text("default_branch"),
  worktreePath: text("worktree_path"),
  branch: text("branch"),
  baseBranch: text("base_branch"),
  baseCommitSha: text("base_commit_sha"),
  mergedHeadSha: text("merged_head_sha"),
  /**
   * TRUE on the ONE workspace-scoped row that represents the workspace's LEADING repo
   * (#222 stage 1, backfilled by migration 0110). Historically the leading repo had no
   * `repos` row — its git state lives on the `workspaces` columns and `leadingRef()`
   * synthesizes the row at read time. This physical row is the target the epic migrates
   * reads onto (stage 2) so the workspace mirror columns can eventually drop (stage 4).
   * Every query that means "the SIBLING repos of a workspace" MUST filter this out.
   */
  isLeading: integer("is_leading", { mode: "boolean" }).notNull().default(false),
  /**
   * #415 — the per-repo merge-status projection (extends #399 / decision 014 to repos
   * rows, migration 0118). `summaryAhead` = commits on `branch` not on `baseBranch`;
   * `summaryHistoric` = commits between `baseCommitSha` and the branch tip when ahead
   * is 0. Together they derive hasWork/merged/stranded with zero git spawns while
   * fresh. `summaryDirty` is set by the same board events that dirty the workspace
   * projection (status transitions, merge stamps, rebase) and cleared by the refresh
   * write-through; the bounded 5-minute heal pass also refreshes stale rows. Default
   * dirty=1 so every pre-0118 row heals on first sight.
   */
  summaryAhead: integer("summary_ahead"),
  summaryHistoric: integer("summary_historic"),
  summaryGitRefreshedAt: text("summary_git_refreshed_at"),
  summaryDirty: integer("summary_dirty", { mode: "boolean" }).notNull().default(true),
  /**
   * #628 — per-repo dependency-install state, on the WORKSPACE-scoped rows only.
   *
   * NULL means "not tracked", which is every row created under the inline install modes
   * (`sequential`/`parallel`): there, the install has already finished by the time the row
   * exists, so there is no state to report. Only the `background` mode writes it, moving a
   * row `pending` -> `running` -> `done` | `failed` | `skipped` while the agent is already
   * working. The merge gate reads it, because deferring the install is only safe if
   * something still refuses to LAND a branch whose deps never came up.
   */
  installState: text("install_state"),
  /** Human-readable why for a `failed`/`skipped` row (exit code + stderr tail). */
  installDetail: text("install_detail"),
  installUpdatedAt: text("install_updated_at"),
  createdAt: text("created_at").notNull().$defaultFn(() => new Date().toISOString()),
}, (table) => [
  index("repos_project_id_idx").on(table.projectId),
  index("repos_workspace_id_idx").on(table.workspaceId),
]);
