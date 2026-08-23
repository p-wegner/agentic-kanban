export { projects } from "./projects.js";
export { projectScriptShortcuts, projectScriptShortcutsRelations } from "./project-script-shortcuts.js";
export { projectStatuses, projectStatusesRelations } from "./project-statuses.js";
export { issues, issuesRelations } from "./issues.js";
export { tags, issueTags, tagsRelations, issueTagsRelations } from "./tags.js";
export { workspaces, workspacesRelations } from "./workspaces.js";
export { sessions, sessionsRelations } from "./sessions.js";
export { sessionMessages, sessionMessagesRelations } from "./session-messages.js";
export { repos } from "./repos.js";
export { preferences } from "./preferences.js";
export { runtimeState } from "./runtime-state.js";
export { diffComments, diffCommentsRelations } from "./diff-comments.js";
export {
  issueDependencies, issueDependenciesRelations, DEPENDENCY_TYPES, DEPENDENCY_TYPE_LABELS,
  SYMMETRIC_DEPENDENCY_TYPES,
} from "./issue-dependencies.js";
// #618: the per-type SEMANTICS live in `lib/dependency-type-traits.ts` and are imported
// from there directly. This barrel deliberately does NOT re-export them: schema is the
// innermost element, so a `shared-schema -> shared-lib` edge inverts the layering. The
// re-export added with #523 was a convenience that created exactly that edge; consumers
// import the deep path instead. (Re-exporting from the schema MODULE is also not an
// option — that direction is a cycle.)
export type { DependencyType } from "./issue-dependencies.js";
export { agentSkills } from "./agent-skills.js";
export { issueArtifacts, issueArtifactsRelations } from "./issue-artifacts.js";
export { issueComments, issueCommentsRelations } from "./issue-comments.js";
export { scheduledRuns, scheduledRunHistory } from "./scheduled-runs.js";
export { failurePatterns } from "./failure-patterns.js";
export {
  flakyTests,
  flakyTestsRelations,
  testRetryDecisions,
  testRetryDecisionsRelations,
} from "./flaky-tests.js";
export { showdowns, showdownsRelations } from "./showdowns.js";
export {
  workflowTemplates,
  workflowNodes,
  workflowEdges,
  workflowTransitions,
  workflowTemplatesRelations,
  workflowNodesRelations,
  workflowEdgesRelations,
  workflowTransitionsRelations,
  WORKFLOW_NODE_TYPES,
  WORKFLOW_EDGE_CONDITIONS,
} from "./workflows.js";
export type { WorkflowNodeType, WorkflowEdgeCondition } from "./workflows.js";
export { testRuns, flakyTestPins } from "./test-runs.js";
export { boardHealthEvents, boardHealthEventsRelations } from "./board-health-events.js";
export { baseBranchHealth, baseBranchHealthRelations } from "./base-branch-health.js";
export { qualityMetrics } from "./quality-metrics.js";
export { workers, workerGitTokens, workerEvents } from "./workers.js";
export { plugins, pluginViewProcesses } from "./plugins.js";
export { pluginLoopEvents } from "./plugin-loop-events.js";
export { milestones, milestonesRelations } from "./milestones.js";
export { issueTimeEntries, issueTimeEntriesRelations } from "./issue-time-entries.js";
export { drives, drivesRelations, DRIVE_STATUSES } from "./drives.js";
export type { DriveStatus } from "./drives.js";
export {
  driveObstacles,
  driveObstaclesRelations,
  DRIVE_OBSTACLE_KINDS,
  DRIVE_OBSTACLE_SEVERITIES,
} from "./drive-obstacles.js";
export type { DriveObstacleKind, DriveObstacleSeverity } from "./drive-obstacles.js";
export { workspaceProvisioning } from "./workspace-provisioning.js";
export { workspaceIssueMembers, workspaceIssueMembersRelations } from "./workspace-issue-members.js";
// #781: the first column family extracted out of the 88-column `workspaces` table.
export { workspaceMergeBackoff, workspaceMergeBackoffRelations } from "./workspace-merge-backoff.js";
// #798: the second, extracted the same way (#283 review-preflight backoff).
export { workspaceReviewPreflight, workspaceReviewPreflightRelations } from "./workspace-review-preflight.js";
// #798: the third — the computed code-metrics artifact.
export { workspaceCodeMetrics, workspaceCodeMetricsRelations } from "./workspace-code-metrics.js";
// #798: the fourth — the dependency-symlink bootstrap run.
export { workspaceSymlinkRun, workspaceSymlinkRunRelations } from "./workspace-symlink-run.js";
// #815: the fifth — the pre-merge gate's evidence quartet-plus-source.
export { workspaceMergeGate, workspaceMergeGateRelations } from "./workspace-merge-gate.js";
// #815: the sixth — the cached merge-tree conflict probe.
export { workspaceConflictCache, workspaceConflictCacheRelations } from "./workspace-conflict-cache.js";
// #815: the seventh — the setup-script run record.
export { workspaceSetupRun, workspaceSetupRunRelations } from "./workspace-setup-run.js";
// #815: the eighth — the persisted workspace-summary git projection.
export { workspaceSummary, workspaceSummaryRelations } from "./workspace-summary.js";
// #815: the ninth — the cached `git diff --shortstat` memo.
export { workspaceDiffStatCache, workspaceDiffStatCacheRelations } from "./workspace-diff-stat-cache.js";
// #815: the tenth — the computed PR-quality scorecard artifact.
export { workspaceScorecard, workspaceScorecardRelations } from "./workspace-scorecard.js";
