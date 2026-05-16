import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";

export const agentSkills = sqliteTable("agent_skills", {
  id: text("id").primaryKey(),
  name: text("name").notNull().unique(),
  description: text("description").notNull(),
  prompt: text("prompt").notNull(),
  model: text("model"),
  isBuiltin: integer("is_builtin", { mode: "boolean" }).notNull().default(false),
  createdAt: text("created_at").notNull().$defaultFn(() => new Date().toISOString()),
  updatedAt: text("updated_at").notNull().$defaultFn(() => new Date().toISOString()),
});
