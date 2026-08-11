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
  /**
   * Real evidence of when/how the pre-merge gate last ACTUALLY ran and passed for this
   * workspace, persisted at the moment `readyForMerge` is set from a real gate run
   * (review-exit). Distinct from `updatedAt`/`readyForMerge` themselves, which say nothing
   * about whether or when a gate ran — a monitor merge trigger reads THESE to build honest
   * `MergeGateEvidence` instead of fabricating `ranAt: new Date()` (#182). Null when
   * `readyForMerge` was set with no gate run (e.g. manual `POST .../ready-for-merge`), which
   * correctly forces `resolveMergeGate` to re-run the gate before merging.
   */
  mergeGateRanAt: text("merge_gate_ran_at"),
  mergeGateStage: text("merge_gate_stage"),
  mergeGateSource: text("merge_gate_source"),
  /**
   * The branch/base tips the gate actually ran against (0108). These make the evidence above
   * verifiable by CONTENT rather than by age: when both still match, a long queue wait no
   * longer forces a pointless re-gate, and when either has moved the proof is void however
   * fresh it looks. Nullable for back-compat — rows written before 0108 validate on age only.
   */
  mergeGateBranchSha: text("merge_gate_branch_sha"),
  mergeGateBaseSha: text("merge_gate_base_sha"),
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
  /**
   * #399 (decision 014) — the workspace-summary GIT PROJECTION. The two phase-4 git facts
   * (`git log -1` sha+subject, `git rev-list --count base..HEAD`) persisted per row so board
   * reads never spawn git on the hot path. `summaryGitRefreshedAt` is the per-row staleness
   * stamp; `summaryDirty` is set by board events (status transitions via setWorkspaceStatus,
   * merge stamps, update-base) and cleared by the write-through refresh / heal pass.
   */
  summaryHeadSha: text("summary_head_sha"),
  summaryHeadMessage: text("summary_head_message"),
  summaryCommitCount: integer("summary_commit_count"),
  summaryGitRefreshedAt: text("summary_git_refreshed_at"),
  summaryDirty: integer("summary_dirty", { mode: "boolean" }).notNull().default(true),
  conflictCacheCheckedAt: text("conflict_cache_checked_at"),
  conflictCacheHasConflicts: integer("conflict_cache_has_conflicts", { mode: "boolean" }),
  conflictCacheFiles: text("conflict_cache_files"),
  diffStatCacheCheckedAt: text("diff_stat_cache_checked_at"),
  diffStatCacheHeadSha: text("diff_stat_cache_head_sha"),
  diffStatCacheFilesChanged: integer("diff_stat_cache_files_changed"),
  diffStatCacheInsertions: integer("diff_stat_cache_insertions"),
  diffStatCacheDeletions: integer("diff_stat_cache_deletions"),
  scorecardScore: integer("scorecard_score"),
  scorecardJson: text("scorecard_json"),
  scorecardComputedAt: text("scorecard_computed_at"),
  codeMetricsJson: text("code_metrics_json"),
  codeMetricsComputedAt: text("code_metrics_computed_at"),
  latestSetupCommand: text("latest_setup_command"),
  latestSetupState: text("latest_setup_state"),
  latestSetupStartedAt: text("latest_setup_started_at"),
  latestSetupEndedAt: text("latest_setup_ended_at"),
  latestSetupExitCode: integer("latest_setup_exit_code"),
  latestSetupDurationMs: integer("latest_setup_duration_ms"),
  latestSetupStdoutTail: text("latest_setup_stdout_tail"),
  latestSetupStderrTail: text("latest_setup_stderr_tail"),
  latestSymlinkState: text("latest_symlink_state"),
  latestSymlinkStartedAt: text("latest_symlink_started_at"),
  latestSymlinkEndedAt: text("latest_symlink_ended_at"),
  latestSymlinkDirs: text("latest_symlink_dirs"),
  latestSymlinkLinked: text("latest_symlink_linked"),
  latestSymlinkSkipped: text("latest_symlink_skipped"),
  latestSymlinkFailed: text("latest_symlink_failed"),
  latestSymlinkError: text("latest_symlink_error"),
  /** Latest pre-session agent launch failure, e.g. safety-policy preflight refusal. */
  latestLaunchError: text("latest_launch_error"),
  /**
   * Backoff state for the stranded-review reconciler's rebase preflight (#283). A rebase
   * conflict is DETERMINISTIC given the same branch tip and base tip, so retrying it every
   * 60s cycle can never succeed — it just re-spawns the most expensive git operation the
   * board runs and blocks the event loop. `reviewPreflightSignature` records the
   * `<headSha>..<baseSha>` pair the failures were observed against: when either tip moves
   * the block clears itself (new commits deserve a fresh attempt), and while it holds the
   * reconciler stops after `MAX_REVIEW_PREFLIGHT_ATTEMPTS` and surfaces a drive obstacle
   * instead of looping.
   */
  reviewPreflightFailures: integer("review_preflight_failures").notNull().default(0),
  /** The last rebase-preflight error message, so the block is explainable without the log. */
  reviewPreflightError: text("review_preflight_error"),
  /** `<branchHeadSha>..<baseHeadSha>` the failures above were observed against. */
  reviewPreflightSignature: text("review_preflight_signature"),
  /** Set when the attempt budget was exhausted for the current signature. */
  reviewPreflightBlockedAt: text("review_preflight_blocked_at"),
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
  issueIdIdx: index("idx_workspaces_issue_id").on(table.issueId),
  statusIdx: index("idx_workspaces_status").on(table.status),
  issueIdStatusIdx: index("idx_workspaces_issue_id_status").on(table.issueId, table.status),
  createdAtIdx: index("idx_workspaces_created_at").on(table.createdAt),
  parentWorkspaceIdIdx: index("idx_workspaces_parent_workspace_id").on(table.parentWorkspaceId),
  showdownIdIdx: index("idx_workspaces_showdown_id").on(table.showdownId),
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
