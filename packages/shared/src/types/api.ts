// API request/response types

/** Tagged profile selection — provider-aware replacement for the bare claudeProfile string. */
export interface ProfileSelection {
  provider: "claude" | "codex" | "copilot";
  name: string;
}

/**
 * Selectable Claude model tiers. The value (`""` = profile default) is passed to the
 * `claude` CLI via `--model`. Only applies to Claude profiles; for profiles that define a
 * custom `ANTHROPIC_BASE_URL` (e.g. z.ai/glm), `--model` is omitted server-side so the
 * profile's own `ANTHROPIC_MODEL` env wins.
 */
export const CLAUDE_MODEL_OPTIONS: ReadonlyArray<{ value: string; label: string }> = [
  { value: "", label: "Profile default" },
  { value: "opus", label: "Opus" },
  { value: "sonnet", label: "Sonnet" },
  { value: "haiku", label: "Haiku" },
];

/**
 * Selectable Codex models. Empty means the Codex profile/config default is used.
 */
export const CODEX_MODEL_OPTIONS: ReadonlyArray<{ value: string; label: string }> = [
  { value: "", label: "Profile default" },
  { value: "gpt-5.5", label: "GPT-5.5" },
  { value: "gpt-5.4", label: "GPT-5.4" },
  { value: "gpt-5.4-mini", label: "GPT-5.4 Mini" },
  { value: "gpt-5.3-codex", label: "GPT-5.3 Codex" },
  { value: "gpt-5.3-codex-spark", label: "GPT-5.3 Codex Spark" },
  { value: "gpt-5.2", label: "GPT-5.2" },
];

export interface CreateProjectRequest {
  name?: string;
  repoPath: string;
  description?: string;
  color?: string;
}

export interface UpdateProjectRequest {
  name?: string;
  description?: string;
  color?: string;
  defaultBranch?: string | null;
  setupScript?: string | null;
  setupBlocking?: boolean;
  setupEnabled?: boolean;
  teardownScript?: string | null;
  autoRetryFlakes?: boolean;
  maxRetries?: number;
  symlinkEnabled?: boolean;
  symlinkDirs?: string | string[] | null;
}

export interface ProjectResponse {
  id: string;
  name: string;
  description: string | null;
  color: string | null;
  repoPath: string;
  repoName: string;
  defaultBranch: string | null;
  remoteUrl: string | null;
  setupScript: string | null;
  setupBlocking: boolean;
  setupEnabled: boolean;
  teardownScript: string | null;
  autoRetryFlakes: boolean | null;
  maxRetries: number | null;
  symlinkEnabled: boolean;
  symlinkDirs: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ProjectStatsResponse {
  commitCount: number;
  recentCommits: { hash: string; message: string; date: string }[];
  issueCounts: Record<string, number>;
  detectedBranch: string | null;
  codeMetrics: {
    generatedAt: string;
    productionLoc: number;
    testLoc: number;
    totalLoc: number;
    testRatio: number;
    productionFiles: number;
    testFiles: number;
    sourceFilesScanned: number;
  };
  history: {
    weeks: Array<{
      week: string;
      commits: number;
      insertions: number;
      deletions: number;
      net: number;
      productionNet: number;
      testNet: number;
    }>;
    contributorCount: number;
    topContributors: Array<{ name: string; commits: number }>;
  };
  hotspots: Array<{
    path: string;
    additions: number;
    deletions: number;
    changes: number;
  }>;
}

export type ProjectScriptLastRunStatus = "running" | "success" | "failed" | "error";
export type ProjectScriptCwdMode = "project" | "custom";

export interface ProjectScriptShortcutResponse {
  id: string;
  projectId: string;
  name: string;
  description: string | null;
  command: string;
  cwdMode: ProjectScriptCwdMode;
  workingDir: string | null;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
  lastRun?: {
    status: ProjectScriptLastRunStatus;
    startedAt: string;
    endedAt: string | null;
    exitCode: number | null;
  } | null;
}

export interface CreateProjectScriptShortcutRequest {
  name: string;
  command: string;
  description?: string | null;
  cwdMode?: ProjectScriptCwdMode;
  workingDir?: string | null;
}

export interface UpdateProjectScriptShortcutRequest {
  name?: string;
  command?: string;
  description?: string | null;
  cwdMode?: ProjectScriptCwdMode;
  workingDir?: string | null;
  sortOrder?: number;
}

// ─── Flake Classifier Types ────────────────────────────────────────────────

export type FlakeDecision = "flake" | "suspicious" | "real";
export type FinalOutcome = "confirmed_flake" | "confirmed_real" | "pending";

export interface FlakyTestEntry {
  id: string;
  projectId: string;
  testName: string;
  testFilePath: string | null;
  errorPattern: string | null;
  reason: string | null;
  createdAt: string;
}

export interface CreateFlakyTestRequest {
  testName: string;
  testFilePath?: string;
  errorPattern?: string;
  reason?: string;
}

export interface RetryDecision {
  id: string;
  sessionId: string;
  workspaceId: string;
  testName: string;
  decision: FlakeDecision;
  confidence: number;
  retryCount: number;
  finalOutcome: FinalOutcome;
  reasoning: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ClassifyTestRequest {
  testName: string;
  errorMessage?: string;
  stackTrace?: string;
  changedFiles?: string[];
  testFilePath?: string;
  sessionId: string;
  workspaceId: string;
}

export interface ClassifyTestResponse {
  decision: FlakeDecision;
  confidence: number;
  reasoning: string;
  matchedFlakyTestId?: string;
  changesOverlapWithSubject: boolean;
  decisionId: string;
}

export interface FalseFlakeTelemetry {
  total: number;
  confirmedReal: number;
  confirmedFlake: number;
  pending: number;
  falseFlakeRate: number;
}

export type IssueType = "task" | "bug" | "feature" | "chore";

export type IssueEstimate = "XS" | "S" | "M" | "L" | "XL";

export interface CreateIssueRequest {
  title: string;
  description?: string;
  priority?: "low" | "medium" | "high" | "critical";
  issueType?: IssueType;
  statusId: string;
  projectId: string;
  skipAutoReview?: boolean;
  estimate?: IssueEstimate;
  /** Optional configurable-workflow template; null/omitted = auto-route by ticket type. */
  workflowTemplateId?: string | null;
  /** Optional external-tracker identifier (e.g. "PROJ-123"). */
  externalKey?: string | null;
  /** Optional external-tracker deep link; must be http/https. */
  externalUrl?: string | null;
}

export interface UpdateIssueRequest {
  title?: string;
  description?: string;
  priority?: "low" | "medium" | "high" | "critical";
  issueType?: IssueType;
  statusId?: string;
  sortOrder?: number;
  estimate?: IssueEstimate | null;
  skipAutoReview?: boolean;
  dueDate?: string | null;
  /** Optional external-tracker identifier (e.g. "PROJ-123"). */
  externalKey?: string | null;
  /** Optional external-tracker deep link; must be http/https. */
  externalUrl?: string | null;
}

export interface MainWorkspaceInfo {
  id: string;
  branch: string;
  workingDir: string | null;
  status: "active" | "reviewing" | "fixing" | "idle" | "awaiting-plan-approval" | "error" | "closed";
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
  scorecard?: { score: number } | null;
  codeMetrics?: WorkspaceCodeMetrics | null;
  workflow?: {
    currentNodeId: string;
    currentNodeName: string;
    currentNodeType: string;
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

export interface QualityMetricRecord {
  id: string;
  projectId: string;
  metricKey: string;
  value: number;
  unit: string | null;
  meta: unknown;
  collectedAt: string;
  commitSha: string | null;
}

export interface QualityMetricsResponse {
  latest: QualityMetricRecord[];
  trend: QualityMetricRecord[];
}

export interface CreateQualityMetricsRequest {
  commitSha?: string | null;
  collectedAt?: string | null;
  metrics: Array<{
    metricKey: string;
    value: number;
    unit?: string | null;
    meta?: unknown;
  }>;
}

export interface IssueWithStatus {
  id: string;
  issueNumber: number | null;
  title: string;
  description: string | null;
  priority: string;
  issueType: string;
  sortOrder: number;
  statusId: string;
  projectId: string;
  createdAt: string;
  updatedAt: string;
  statusChangedAt: string | null;
  statusName: string;
  workspaceSummary?: WorkspaceSummary;
  isBlocked?: boolean;
  skipAutoReview?: boolean;
  estimate?: string | null;
  dueDate?: string | null;
  externalKey?: string | null;
  externalUrl?: string | null;
  tags?: { id: string; name: string; color: string | null }[];
}

export interface StatusWithIssues {
  id: string;
  name: string;
  projectId: string;
  sortOrder: number;
  issues: IssueWithStatus[];
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
}

export interface IssueArtifact {
  id: string;
  issueId: string;
  workspaceId: string | null;
  type: "image" | "text" | "link" | "video";
  mimeType: string | null;
  content: string;
  caption: string | null;
  createdAt: string;
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

// Stage 3 types

export interface SetupWorkspaceRequest {
  repoPath?: string;
}

export interface LaunchAgentRequest {
  prompt: string;
  agentCommand?: string;
  resumeFromId?: string;
}

export interface SessionResponse {
  id: string;
  workspaceId: string;
  executor: string;
  status: string;
  startedAt: string;
  endedAt: string | null;
  providerSessionId?: string | null;
  resumeFromId?: string | null;
}

export interface DiffResponse {
  diff: string;
  stats: {
    filesChanged: number;
    insertions: number;
    deletions: number;
  };
  comments: DiffComment[];
  conflicts?: { hasConflicts: boolean; conflictingFiles: string[] } | null;
}

export interface DiffComment {
  id: string;
  workspaceId: string;
  filePath: string;
  lineNumOld: number | null;
  lineNumNew: number | null;
  side: "old" | "new";
  body: string;
  resolvedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateDiffCommentRequest {
  filePath: string;
  lineNumOld?: number | null;
  lineNumNew?: number | null;
  side: "old" | "new";
  body: string;
}

export interface AgentOutputMessage {
  type: "stdout" | "stderr" | "exit" | "bisect";
  sessionId: string;
  data?: string;
  exitCode?: number | null;
}

export interface SessionSummaryAction {
  type: string;
  files?: string[];
  commands?: string[];
}

export interface SessionTaskItem {
  id: string;
  subject: string;
  description?: string;
  status: "pending" | "in_progress" | "completed" | "deleted";
}

export interface SessionSummaryResponse {
  sessionId: string;
  duration: string | null;
  stats: Record<string, unknown> | null;
  status: string;
  startedAt: string;
  endedAt: string | null;
  overview: string;
  agentSummary: string | null;
  actions: SessionSummaryAction[];
  keyExcerpts: string[];
  errors: string[];
  filesRead: string[];
  filesEdited: string[];
  filesWritten: string[];
  commandsRun: string[];
  model: string;
  tasks: SessionTaskItem[];
}

import type { DependencyType } from "../schema/index.js";

export interface DependencyItem {
  id: string;
  issueId: string;
  dependsOnId: string;
  type: DependencyType;
  createdAt: string;
  issueTitle: string;
  issueStatusName: string;
  issueNumber: number | null;
}

export interface DependencyInfo {
  dependencies: DependencyItem[];
}

export interface DependencyWaveIssue {
  id: string;
  issueNumber: number | null;
  title: string;
  statusName: string;
  startEligible: boolean;
  blockers: Array<{
    issueId: string;
    issueNumber: number | null;
    title: string;
    statusName: string;
  }>;
  reasons: string[];
}

export interface DependencyWavePlan {
  projectId: string;
  readyNow: DependencyWaveIssue[];
  blocked: DependencyWaveIssue[];
  cyclicInvalid: DependencyWaveIssue[];
  wip: {
    current: number;
    limit: number;
    available: number;
  };
}

export interface DependencyWaveStartResult {
  started: Array<{ issueId: string; issueNumber: number | null; workspaceId: string }>;
  failed: Array<{ issueId: string; issueNumber: number | null; error: string }>;
  skipped: {
    wipLimit: number;
    currentWip: number;
    availableSlots: number;
    readyButNotStarted: number;
  };
}

export interface BoardStatusIssue {
  issueNumber: number | null;
  issueId: string;
  title: string;
  priority: string;
  issueType: string;
  statusName: string;
  workspace: {
    id: string;
    branch: string;
    status: string;
    workingDir: string | null;
    baseBranch: string | null;
    isDirect: boolean;
    readyForMerge: boolean;
  } | null;
  session: {
    id: string;
    status: string;
    startedAt: string;
    endedAt: string | null;
  } | null;
  sessionStats: {
    durationMs: number;
    totalCostUsd: number;
    inputTokens: number;
    outputTokens: number;
    numTurns: number;
    model: string;
    success: boolean;
    agentSummary?: string;
  } | null;
  diffStats: { filesChanged: number; insertions: number; deletions: number } | null;
  conflicts: { hasConflicts: boolean; conflictingFiles: string[] } | null;
  lastActivity: string | null;
  lastOutput: string[];
  lastAgentMessage: string | null;
  attention?: {
    bucket: "needs_attention";
    reason: "idle-awaiting" | "stale-in-review" | "closed-in-review";
    label: string;
  } | null;
  mergeState?: {
    bucket: "pending_merge";
    reason: "auto-merge-in-review";
    label: string;
  } | null;
}

export interface BoardStatusResponse {
  project: { id: string; name: string; repoPath: string; defaultBranch: string | null };
  generatedAt: string;
  totals: { totalIssues: number; inProgress: number; activeWorkspaces: number; runningSessions: number };
  issues: BoardStatusIssue[];
}

export type LaunchFailureCategory = "zero-output" | "setup-failed" | "missing-worktree" | "session-error";

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
