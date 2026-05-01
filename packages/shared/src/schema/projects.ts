import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";

export const projects = sqliteTable("projects", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  description: text("description"),
  color: text("color"),
  repoPath: text("repo_path").notNull().default(""),
  repoName: text("repo_name").notNull().default(""),
  defaultBranch: text("default_branch").notNull().default("main"),
  remoteUrl: text("remote_url"),
  createdAt: text("created_at").notNull().$defaultFn(() => new Date().toISOString()),
  updatedAt: text("updated_at").notNull().$defaultFn(() => new Date().toISOString()),
});
