import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";

export const projects = sqliteTable("projects", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  description: text("description"),
  color: text("color"),
  repoPath: text("repo_path").notNull().default(""),
  repoName: text("repo_name").notNull().default(""),
  defaultBranch: text("default_branch"),
  remoteUrl: text("remote_url"),
  setupScript: text("setup_script"),
  setupBlocking: integer("setup_blocking", { mode: "boolean" }).notNull().default(true),
  setupEnabled: integer("setup_enabled", { mode: "boolean" }).notNull().default(true),
  teardownScript: text("teardown_script"),
  /** Auto-retry tests classified as flakes (uses flake-classifier). Default: true. */
  autoRetryFlakes: integer("auto_retry_flakes", { mode: "boolean" }).default(true),
  /** Maximum number of automatic retries for flake-classified test failures. Default: 2. */
  maxRetries: integer("max_retries").default(2),
  /** Whether to symlink dependency directories from the main checkout into new worktrees. Default: false. */
  symlinkEnabled: integer("symlink_enabled", { mode: "boolean" }).notNull().default(false),
  /** JSON array of directory names to symlink (e.g. '["node_modules",".venv"]'). */
  symlinkDirs: text("symlink_dirs"),
  /** Default skill applied to new workspaces when no explicit skill is chosen and no workflow provides one. */
  defaultSkillId: text("default_skill_id"),
  /** ISO timestamp when the project was archived; null = active. Archived projects are hidden from the default project list. */
  archivedAt: text("archived_at"),
  /** JSON `ServiceStackConfig` — declared per-workspace Docker Compose service stack (nullable = none). */
  servicesConfig: text("services_config"),
  createdAt: text("created_at").notNull().$defaultFn(() => new Date().toISOString()),
  updatedAt: text("updated_at").notNull().$defaultFn(() => new Date().toISOString()),
});
