import { sqliteTable, text, integer, index } from "drizzle-orm/sqlite-core";
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
  baseCommitSha: text("base_commit_sha"),
  requiresReview: integer("requires_review", { mode: "boolean" }).notNull().default(false),
  thoroughReview: integer("thorough_review", { mode: "boolean" }).notNull().default(false),
  readyForMerge: integer("ready_for_merge", { mode: "boolean" }).notNull().default(false),
  planMode: integer("plan_mode", { mode: "boolean" }).notNull().default(false),
  tddMode: integer("tdd_mode", { mode: "boolean" }).notNull().default(false),
  status: text("status").notNull().default("active"),
  claudeProfile: text("claude_profile"),
  agentCommand: text("agent_command"),
  provider: text("provider"),
  model: text("model"),
  pendingPlanPath: text("pending_plan_path"),
  skillId: text("skill_id").references(() => agentSkills.id),
  // The workflow node this workspace's agent is currently executing.
  currentNodeId: text("current_node_id"),
  // Parallel fork/join (workflow graphs): for a fork child, the parent workspace
  // that spawned it; the fork node that spawned it; the join node its path
  // converges to; and the child lifecycle state ('running'|'queued'|'joined'|'cancelled').
  parentWorkspaceId: text("parent_workspace_id"),
  forkNodeId: text("fork_node_id"),
  forkJoinNodeId: text("fork_join_node_id"),
  forkStatus: text("fork_status"),
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
  scorecardScore: integer("scorecard_score"),
  scorecardJson: text("scorecard_json"),
  scorecardComputedAt: text("scorecard_computed_at"),
}, (table) => ({
  issueIdIdx: index("idx_workspaces_issue_id").on(table.issueId),
  statusIdx: index("idx_workspaces_status").on(table.status),
  createdAtIdx: index("idx_workspaces_created_at").on(table.createdAt),
  parentWorkspaceIdIdx: index("idx_workspaces_parent_workspace_id").on(table.parentWorkspaceId),
}));

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
