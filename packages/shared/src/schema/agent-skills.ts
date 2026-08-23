import { sqliteTable, text, integer, index, uniqueIndex } from "drizzle-orm/sqlite-core";
import { projects } from "./projects.js";

export const agentSkills = sqliteTable("agent_skills", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  description: text("description").notNull(),
  prompt: text("prompt").notNull(),
  model: text("model"),
  projectId: text("project_id").references(() => projects.id),
  isBuiltin: integer("is_builtin", { mode: "boolean" }).notNull().default(false),
  // An init skill is meant to run once, early, against a newly imported project — its
  // output is a durable artifact (docs, a profile, a review), never a code change. It is
  // a *suggestion* surfaced to the onboarding flow, never auto-run by the board itself.
  isInit: integer("is_init", { mode: "boolean" }).notNull().default(false),
  type: text("type").notNull().default("skill"),
  // Hash of the canonical built-in content this row was last seeded/refreshed with
  // (null for user-created skills and for legacy rows seeded before the hash existed).
  // Used by ensureBuiltinSkills to refresh unedited built-ins when the shipped prompt
  // changes, while leaving user-edited rows untouched.
  contentHash: text("content_hash"),
  createdAt: text("created_at").notNull().$defaultFn(() => new Date().toISOString()),
  updatedAt: text("updated_at").notNull().$defaultFn(() => new Date().toISOString()),
}, (table) => ({
  // FK-supporting index (#740); also the hot path for project-scoped skill lookups.
  projectIdIdx: index("idx_agent_skills_project_id").on(table.projectId),
  // Declared in a migration but absent here until #812. A skill NAME is UNIQUE per
  // scope, and the DB enforces it; leaving the constraint undeclared made this file an
  // incomplete picture of the table.
  nameScopeUnique: uniqueIndex("agent_skills_name_scope_unique").on(table.name, table.projectId),
}));
