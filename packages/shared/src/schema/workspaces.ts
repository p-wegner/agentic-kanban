import { sqliteTable, text, integer, index } from "drizzle-orm/sqlite-core";
import { relations } from "drizzle-orm";
import { issues } from "./issues.js";
import { agentSkills } from "./agent-skills.js";

/**
 * 41 columns, and it should not become 42 (#739, #781, #798, #815).
 *
 * The next widest table in this schema has 23 (`issues`, `repos`); the median across 44
 * tables is 9. What is here is not one entity but two remaining concerns flattened into one row by
 * prefix — `scorecard_*` (3) and `fork_*`/`showdown_*` (5). Nine families are no longer
 * among them:
 * #781 extracted `merge_backoff_*` (7) to `workspace_merge_backoff`, #798 extracted
 * `review_preflight_*` (4), `code_metrics_*` (2) and `latest_symlink_*` (8) to
 * `workspace_review_preflight`, `workspace_code_metrics` and `workspace_symlink_run`, and
 * #815 extracted `merge_gate_*` (5), `conflict_cache_*` (3), `latest_setup_*` (8),
 * `summary_*` (5) and `diff_stat_cache_*` (5) to `workspace_merge_gate`,
 * `workspace_conflict_cache`, `workspace_setup_run`, `workspace_summary` and
 * `workspace_diff_stat_cache`.
 * The one family still queued for extraction is `scorecard_*` (highest fan-out, last).
 * Each `latest_*` / `*_cache_*` / `*_gate_*` group is a one-to-many relationship collapsed
 * to its last row: there is one setup run per column set, so its history is unrecoverable by
 * construction, and any new field on any of those concerns is another `ALTER TABLE` on the
 * hottest table in the board.
 *
 * A new field on one of those concerns therefore belongs in that concern's OWN table, keyed
 * by `workspace_id` — not in another column here. `workspaces-table-width-ratchet.test.ts`
 * enforces that: the total and each family count are pinned, so widening fails the gate.
 *
 * Twelve columns are NULL in all 659 rows of the live DB — `agent_command`,
 * `pending_plan_path`, `parent_workspace_id`, `fork_node_id`, `fork_join_node_id`,
 * `fork_status`, `showdown_id`, `showdown_label`, `service_state`,
 * `isolation_downgrade_reason` — ten left here, after #798 moved
 * `review_preflight_blocked_at` and `latest_symlink_error` into their families' own tables.
 * **None of them is dead.**
 * #739 checked every one: each has a real writer and a real reader (fork via
 * `workflow-fork.service`, showdown via `POST /api/issues/:id/showdown`, service_state via
 * the Docker service-stack repository, and so on). They are NULL because no row on that
 * instance has reached that state, which is a usage fact, not a schema fact — so dropping
 * them would delete working features. The remedy for this table is extraction, not deletion —
 * sequenced, with the coupling of each family counted, in #781 and #798.
 */
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
  // Showdown: group multiple sibling workspaces competing on the same issue
  showdownId: text("showdown_id"),
  /** Slot label for this contestant: 'a', 'b', 'c', 'd' */
  showdownLabel: text("showdown_label"),
  includeVisualProof: integer("include_visual_proof", { mode: "boolean" }).notNull().default(false),
  createdAt: text("created_at").notNull().$defaultFn(() => new Date().toISOString()),
  updatedAt: text("updated_at").notNull().$defaultFn(() => new Date().toISOString()),
  closedAt: text("closed_at"),
  /** Set when the workspace's branch was actually merged into its base (not on abandoned/direct close). */
  mergedAt: text("merged_at"),
  /**
   * The branch-tip commit SHA captured at merge time. Survives the post-merge
   * branch deletion (the commit stays reachable from the default branch), so the
   * merged-commits panel can still resolve `baseCommitSha..mergedHeadSha` after
   * the feature branch ref is gone.
   */
  mergedHeadSha: text("merged_head_sha"),
  scorecardScore: integer("scorecard_score"),
  scorecardJson: text("scorecard_json"),
  scorecardComputedAt: text("scorecard_computed_at"),
  /** Latest pre-session agent launch failure, e.g. safety-policy preflight refusal. */
  latestLaunchError: text("latest_launch_error"),
  /** Context primer assembled by the context-packer at workspace creation. Injected into CLAUDE.local.md. */
  contextPrimer: text("context_primer"),
  /** Set when worktree removal fails post-merge (e.g. EBUSY). Cleared on successful retry cleanup. */
  cleanupWarning: text("cleanup_warning"),
  /** JSON `ServiceStackState` — this workspace's provisioned Docker service stack (compose project name, allocated ports, env file, status). Nullable = no stack. */
  serviceState: text("service_state"),
  /**
   * Set when this workspace requested containerized isolation (`devcontainer_builders`
   * on) but the builder actually ran on the HOST — a security-posture downgrade for a
   * feature whose purpose is isolation (decision 011). Cleared on a launch that
   * containerizes successfully.
   */
  isolationDowngraded: integer("isolation_downgraded", { mode: "boolean" }).notNull().default(false),
  /** Human-readable reason for the isolation downgrade (CLI missing, provisioning failed, ...). */
  isolationDowngradeReason: text("isolation_downgrade_reason"),
}, (table) => ({
  statusIdx: index("idx_workspaces_status").on(table.status),
  issueIdStatusIdx: index("idx_workspaces_issue_id_status").on(table.issueId, table.status),
  createdAtIdx: index("idx_workspaces_created_at").on(table.createdAt),
  parentWorkspaceIdIdx: index("idx_workspaces_parent_workspace_id").on(table.parentWorkspaceId),
  showdownIdIdx: index("idx_workspaces_showdown_id").on(table.showdownId),
  // FK-supporting index (#740).
  skillIdIdx: index("idx_workspaces_skill_id").on(table.skillId),
  // Migration-only until #812: "this issue's workspaces, newest first".
  issueIdCreatedAtIdx: index("idx_workspaces_issue_id_created_at").on(table.issueId, table.createdAt),
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
