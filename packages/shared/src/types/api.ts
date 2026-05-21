// API request/response types

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
  setupScript?: string | null;
  setupBlocking?: boolean;
  setupEnabled?: boolean;
  teardownScript?: string | null;
}

export interface ProjectResponse {
  id: string;
  name: string;
  description: string | null;
  color: string | null;
  repoPath: string;
  repoName: string;
  defaultBranch: string;
  remoteUrl: string | null;
  setupScript: string | null;
  setupBlocking: boolean;
  setupEnabled: boolean;
  teardownScript: string | null;
  createdAt: string;
  updatedAt: string;
}

export type IssueEstimate = "XS" | "S" | "M" | "L" | "XL";

export interface CreateIssueRequest {
  title: string;
  description?: string;
  priority?: "low" | "medium" | "high" | "critical";
  statusId: string;
  projectId: string;
  skipAutoReview?: boolean;
  estimate?: IssueEstimate;
}

export interface UpdateIssueRequest {
  title?: string;
  description?: string;
  priority?: "low" | "medium" | "high" | "critical";
  statusId?: string;
  sortOrder?: number;
  estimate?: IssueEstimate | null;
  skipAutoReview?: boolean;
}

export interface MainWorkspaceInfo {
  id: string;
  branch: string;
  status: "active" | "reviewing" | "idle" | "closed";
  readyForMerge?: boolean;
  claudeProfile?: string | null;
  agentCommand?: string | null;
  diffStats?: { filesChanged: number; insertions: number; deletions: number } | null;
  conflicts?: { hasConflicts: boolean; conflictingFiles: string[] } | null;
  lastSessionAt?: string | null;
}

export interface WorkspaceSummary {
  total: number;
  active: number;
  idle: number;
  closed: number;
  branches: string[];
  main?: MainWorkspaceInfo;
}

export interface IssueWithStatus {
  id: string;
  issueNumber: number | null;
  title: string;
  description: string | null;
  priority: string;
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
  status?: "active" | "reviewing" | "idle" | "closed";
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
  sessionId?: string;
  skillId?: string | null;
  skillName?: string | null;
  createdAt: string;
  updatedAt: string;
  closedAt?: string | null;
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
  type: "stdout" | "stderr" | "exit";
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

export interface BoardStatusIssue {
  issueNumber: number | null;
  issueId: string;
  title: string;
  priority: string;
  statusName: string;
  workspace: {
    id: string;
    branch: string;
    status: string;
    workingDir: string | null;
    baseBranch: string | null;
    isDirect: boolean;
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
}

export interface BoardStatusResponse {
  project: { id: string; name: string; repoPath: string; defaultBranch: string };
  generatedAt: string;
  totals: { totalIssues: number; inProgress: number; activeWorkspaces: number; runningSessions: number };
  issues: BoardStatusIssue[];
}
