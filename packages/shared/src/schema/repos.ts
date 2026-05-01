import { sqliteTable, text } from "drizzle-orm/sqlite-core";
import { workspaces } from "./workspaces.js";
import { projects } from "./projects.js";

export const repos = sqliteTable("repos", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").references(() => workspaces.id),
  projectId: text("project_id").references(() => projects.id),
  path: text("path").notNull(),
  name: text("name"),
  scripts: text("scripts"),
  createdAt: text("created_at").notNull().$defaultFn(() => new Date().toISOString()),
});
