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
  createdAt: text("created_at").notNull().$defaultFn(() => new Date().toISOString()),
  updatedAt: text("updated_at").notNull().$defaultFn(() => new Date().toISOString()),
});
