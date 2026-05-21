import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";
import { relations } from "drizzle-orm";
import { issues } from "./issues.js";
import { agentSkills } from "./agent-skills.js";

export const workspaces = sqliteTable("workspaces", {
  id: text("id").primaryKey(),
  issueId: text("issue_id").notNull().references(() => issues.id),
  branch: text("branch").notNull(),
  workingDir: text("working_dir"),
  baseBranch: text("base_branch"),
  isDirect: integer("is_direct", { mode: "boolean" }).notNull().default(false),
  requiresReview: integer("requires_review", { mode: "boolean" }).notNull().default(false),
  thoroughReview: integer("thorough_review", { mode: "boolean" }).notNull().default(false),
  readyForMerge: integer("ready_for_merge", { mode: "boolean" }).notNull().default(false),
  planMode: integer("plan_mode", { mode: "boolean" }).notNull().default(false),
  status: text("status").notNull().default("active"),
  claudeProfile: text("claude_profile"),
  agentCommand: text("agent_command"),
  skillId: text("skill_id").references(() => agentSkills.id),
  includeVisualProof: integer("include_visual_proof", { mode: "boolean" }).notNull().default(false),
  createdAt: text("created_at").notNull().$defaultFn(() => new Date().toISOString()),
  updatedAt: text("updated_at").notNull().$defaultFn(() => new Date().toISOString()),
  closedAt: text("closed_at"),
  conflictCacheCheckedAt: text("conflict_cache_checked_at"),
  conflictCacheHasConflicts: integer("conflict_cache_has_conflicts", { mode: "boolean" }),
  conflictCacheFiles: text("conflict_cache_files"),
  diffStatCacheCheckedAt: text("diff_stat_cache_checked_at"),
  diffStatCacheFilesChanged: integer("diff_stat_cache_files_changed"),
  diffStatCacheInsertions: integer("diff_stat_cache_insertions"),
  diffStatCacheDeletions: integer("diff_stat_cache_deletions"),
});

export const workspacesRelations = relations(workspaces, ({ one, many }) => ({
  issue: one(issues, {
    fields: [workspaces.issueId],
    references: [issues.id],
  }),
  skill: one(agentSkills, {
    fields: [workspaces.skillId],
    references: [agentSkills.id],
  }),
  sessions: many(sessions),
  diffComments: many(diffComments),
}));

import { sessions } from "./sessions.js";
import { diffComments } from "./diff-comments.js";
