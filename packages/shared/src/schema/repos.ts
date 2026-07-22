import { index, sqliteTable, text } from "drizzle-orm/sqlite-core";
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
  createdAt: text("created_at").notNull().$defaultFn(() => new Date().toISOString()),
}, (table) => [
  index("repos_project_id_idx").on(table.projectId),
  index("repos_workspace_id_idx").on(table.workspaceId),
]);
