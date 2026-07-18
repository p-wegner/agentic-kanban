// Workspace / showdown / launch-failure / timeline wire-contract types (pure DTOs).
// See ../api.ts barrel.
import type { ProfileSelection } from "./common.js";
import type { ServiceStackState } from "../service-stack.js";

export interface MainWorkspaceInfo {
  id: string;
  branch: string;
  workingDir: string | null;
  status: "active" | "reviewing" | "fixing" | "idle" | "blocked" | "awaiting-plan-approval" | "error" | "closed";
  readyForMerge?: boolean;
  planMode?: boolean;
  /** @deprecated Use profile instead */
  claudeProfile?: string | null;
  profile?: ProfileSelection | null;
  /** Selected Claude model tier (e.g. "opus"); null/empty = profile default. */
  model?: string | null;
  agentCommand?: string | null;
  diffStats?: { filesChanged: number; insertions: number; deletions: number } | null;
  conflicts?: { hasConflicts: boolean; conflictingFiles: string[] } | null;
  lastSessionAt?: string | null;
  sessionStatus?: string | null;
  lastSessionTriggerType?: string | null;
  /** Set when the workspace's branch was actually merged into its base (distinguishes merged from abandoned-closed). */
  mergedAt?: string | null;
  commitCount?: number | null;
  contextTokens?: number | null;
  lastTool?: string | null;
  lastAssistantMessage?: string | null;
  /** True when a non-plan-mode session completed (idle) but produced no file changes. */
  planOnlyWarning?: boolean;
  pendingPlanPath?: string | null;
  scorecard?: { score: number } | null;
  codeMetrics?: WorkspaceCodeMetrics | null;
  latestCommit?: { sha: string; message: string } | null;
  workflow?: {
    currentNodeId: string;
    currentNodeName: string;
    currentNodeType: string;
    currentNodeStatusName?: string | null;
    state: "active" | "waiting" | "terminal";
    nextStages: string[];
  } | null;
}

export interface WorkspaceSummary {
  total: number;
  active: number;
  idle: number;
  closed: number;
  branches: string[];
  main?: MainWorkspaceInfo;
  /** Set when workspaces in this issue belong to a showdown. */
  showdown?: {
    id: string;
    /** 'active' | 'decided' */
    status: string;
    total: number;
    /** Number of contestants that have reached idle/closed status. */
    doneCount: number;
  };
}

export interface WorkspaceCodeMetrics {
  computedAt: string;
  coverage?: {
    linesPct: number;
    covered?: number;
    total?: number;
    source: string;
  } | null;
  lint?: {
    errors: number;
    warnings: number;
    violations: number;
    source: string;
  } | null;
  complexity?: {
    average: number;
    max: number;
    files: number;
    source: "heuristic";
  } | null;
}

export type WorkspaceSetupState = "running" | "success" | "failed" | "skipped";

export interface WorkspaceSetupRun {
  command: string | null;
  state: WorkspaceSetupState;
  startedAt: string | null;
  endedAt: string | null;
  exitCode: number | null;
  durationMs: number | null;
  stdoutTail: string | null;
  stderrTail: string | null;
}

export type WorkspaceSymlinkState = "disabled" | "linked" | "skipped" | "failed";

export interface WorkspaceSymlinkRun {
  state: WorkspaceSymlinkState;
  dirs: string[];
  linked: string[];
  skipped: string[];
  failed: Array<{ dir: string; error: string }>;
  startedAt: string | null;
  endedAt: string | null;
  error: string | null;
}

export interface CreateWorkspaceRequest {
  issueId: string;
  branch: string;
  baseBranch?: string;
  workingDir?: string;
  isDirect?: boolean;
  planMode?: boolean;
}

export interface UpdateWorkspaceRequest {
  status?: "active" | "reviewing" | "fixing" | "idle" | "error" | "closed";
  workingDir?: string;
  claudeProfile?: string | null;
  provider?: string | null;
}

export interface WorkspaceResponse {
  id: string;
  issueId: string;
  branch: string;
  status: string;
  workingDir: string | null;
  baseBranch: string | null;
  isDirect: boolean;
  planMode: boolean;
  includeVisualProof: boolean;
  readyForMerge: boolean;
  agentCommand?: string | null;
  provider?: string | null;
  /** @deprecated Use profile instead */
  claudeProfile?: string | null;
  profile?: ProfileSelection | null;
  /** Selected Claude model tier (e.g. "opus"); null/empty = profile default. */
  model?: string | null;
  pendingPlanPath?: string | null;
  sessionId?: string;
  skillName?: string | null;
  contextPrimer?: string | null;
  createdAt: string;
  updatedAt: string;
  closedAt?: string | null;
  mergedAt?: string | null;
  contextTokens?: number | null;
  lastTool?: string | null;
  latestCommit?: { sha: string; message: string } | null;
  conflicts?: { hasConflicts: boolean; conflictingFiles: string[] } | null;
  latestSetup?: WorkspaceSetupRun | null;
  latestSymlink?: WorkspaceSymlinkRun | null;
  /** Per-workspace Docker service stack status + allocated host ports (null = no stack). */
  serviceState?: ServiceStackState | null;
}

/** One repo's entry in GET /api/workspaces/:id/repo-merge-status (#70/#75). */
export interface RepoMergeStatusRepoEntry {
  /** Sibling repo name; null for the leading repo. */
  name: string | null;
  path: string;
  isLeading: boolean;
  /** The repo's branch ever diverged from base (or a sibling merge was stamped). */
  hasWork: boolean;
  /** Commits on the branch not yet on base (0 once landed). */
  ahead: number;
  /** The work has landed on base. */
  merged: boolean;
  /** Has work, but it is NOT on base — the #69 failure mode, made visible. */
  stranded: boolean;
}

/** Response of GET /api/workspaces/:id/repo-merge-status (multi-repo, non-direct workspaces). */
export interface RepoMergeStatusResponse {
  branch: string | null;
  baseBranch: string;
  allMerged: boolean;
  repos: RepoMergeStatusRepoEntry[];
}

/**
 * Response of POST /api/workspaces/:id/repos/:repoName/rebase (per-repo rebase, #93).
 * The reserved `:repoName` for the leading repo is `LEADING_REPO_KEY` (a runtime value,
 * so it lives in lib/branch.ts, re-exported through the barrel).
 */
export interface RepoRebaseResponse {
  /** Which repo was rebased — a sibling name, or "leading" for the leading repo. */
  repo: string;
  /** The rebase completed cleanly onto the latest base. */
  success: boolean;
  /** Files with conflicts when the rebase could not complete (the rebase was aborted, tree left clean). */
  conflictingFiles?: string[];
  error?: string;
}

/** One repo's HANDOFF.md metadata in GET /api/workspaces/:id/handoff (#89). */
export interface WorkspaceHandoffRepoEntry {
  /** Sibling repo name; null for the leading repo. */
  name: string | null;
  /** A HANDOFF.md exists in this repo's worktree. */
  exists: boolean;
  /** ISO mtime of the file (null when absent) — the client's poll+delta key. */
  updatedAt: string | null;
  /** Leading, truncated slice of the file content (null when absent). */
  excerpt: string | null;
}

/**
 * Response of GET /api/workspaces/:id/handoff (#89): the leading repo's HANDOFF.md
 * metadata at the top level (the common single-repo shape), plus a per-repo `repos`
 * array covering the leading repo and every sibling worktree.
 */
export interface WorkspaceHandoffResponse {
  exists: boolean;
  updatedAt: string | null;
  excerpt: string | null;
  repos: WorkspaceHandoffRepoEntry[];
}

export interface ShowdownContestant {
  skillId?: string;
  skillName?: string;
  model?: string;
  profile?: ProfileSelection;
}

export interface ShowdownContestantResult {
  workspaceId: string;
  label: string;
  branch: string;
  status: string;
  skillName: string | null;
  model: string | null;
  diffStats?: { filesChanged: number; insertions: number; deletions: number } | null;
}

export interface ShowdownResponse {
  id: string;
  issueId: string;
  status: string;
  winnerWorkspaceId: string | null;
  contestants: ShowdownContestantResult[];
  createdAt: string;
  updatedAt: string;
}

export interface WorkspaceWithIssue extends WorkspaceResponse {
  issue: {
    title: string;
    priority: string;
  };
}

export interface SetupWorkspaceRequest {
  repoPath?: string;
}

export type LaunchFailureCategory = "zero-output" | "rate-limited" | "setup-failed" | "preflight-failed" | "missing-worktree" | "session-error";

export interface WorkspaceLaunchFailure {
  workspaceId: string;
  workspaceBranch: string;
  workspaceStatus: string;
  workingDir: string | null;
  issueId: string;
  issueNumber: number | null;
  issueTitle: string;
  issueStatusName: string;
  provider: string | null;
  profile: string | null;
  sessionId: string | null;
  sessionStatus: string | null;
  sessionStartedAt: string | null;
  sessionEndedAt: string | null;
  failureCategory: LaunchFailureCategory;
  lastMessage: string | null;
  failedAt: string;
  recentFailureCount: number;
}

export interface WorkspaceLaunchFailuresResponse {
  projectId: string;
  generatedAt: string;
  failures: WorkspaceLaunchFailure[];
}

export type WorkspaceTimelineEventType =
  | "workspace_created"
  | "setup_started"
  | "setup_completed"
  | "setup_failed"
  | "session_launched"
  | "session_stopped"
  | "session_zero_output"
  | "session_completed"
  | "nudge"
  | "review_started"
  | "merge_started"
  | "fix_and_merge_started"
  | "workspace_merged"
  | "workspace_closed"
  | "ready_for_merge";

export interface WorkspaceTimelineEvent {
  id: string;
  type: WorkspaceTimelineEventType;
  timestamp: string;
  /** Brief human-readable description of the event. */
  label: string;
  /** Optional detail: last assistant message, failure reason, monitor decision, etc. */
  detail?: string | null;
  /** Highlight level for the event. */
  severity?: "info" | "warning" | "error" | "success";
  /** Session ID associated with this event, if any. */
  sessionId?: string | null;
  /** Trigger type label (launch, review, fix-conflicts, etc.) */
  triggerType?: string | null;
  /** Token counts when relevant (zero-output detection). */
  tokenCounts?: { inputTokens: number; outputTokens: number } | null;
  /** Exit code for session stop events. */
  exitCode?: string | null;
}

export interface WorkspaceTimelineResponse {
  workspaceId: string;
  generatedAt: string;
  events: WorkspaceTimelineEvent[];
}
