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
  createdAt: string;
  updatedAt: string;
}

export interface CreateIssueRequest {
  title: string;
  description?: string;
  priority?: "low" | "medium" | "high" | "critical";
  statusId: string;
  projectId: string;
  skipAutoReview?: boolean;
}

export interface UpdateIssueRequest {
  title?: string;
  description?: string;
  priority?: "low" | "medium" | "high" | "critical";
  statusId?: string;
  sortOrder?: number;
}

export interface MainWorkspaceInfo {
  id: string;
  branch: string;
  status: "active" | "reviewing" | "idle" | "closed";
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
  sessionId?: string;
  createdAt: string;
  updatedAt: string;
  closedAt?: string | null;
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
  claudeSessionId?: string | null;
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

export interface DependencyItem {
  id: string;
  issueId: string;
  dependsOnId: string;
  createdAt: string;
  issueTitle: string;
  issueStatusName: string;
  issueNumber: number | null;
}

export interface DependencyInfo {
  dependsOn: DependencyItem[];
  blockedBy: DependencyItem[];
}
