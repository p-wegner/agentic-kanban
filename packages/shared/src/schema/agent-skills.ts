import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";
import { projects } from "./projects.js";

export const agentSkills = sqliteTable("agent_skills", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  description: text("description").notNull(),
  prompt: text("prompt").notNull(),
  model: text("model"),
  projectId: text("project_id").references(() => projects.id),
  isBuiltin: integer("is_builtin", { mode: "boolean" }).notNull().default(false),
  type: text("type").notNull().default("skill"),
  // Hash of the canonical built-in content this row was last seeded/refreshed with
  // (null for user-created skills and for legacy rows seeded before the hash existed).
  // Used by ensureBuiltinSkills to refresh unedited built-ins when the shipped prompt
  // changes, while leaving user-edited rows untouched.
  contentHash: text("content_hash"),
  createdAt: text("created_at").notNull().$defaultFn(() => new Date().toISOString()),
  updatedAt: text("updated_at").notNull().$defaultFn(() => new Date().toISOString()),
});
