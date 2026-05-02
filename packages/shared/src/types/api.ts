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
}

export interface UpdateIssueRequest {
  title?: string;
  description?: string;
  priority?: "low" | "medium" | "high" | "critical";
  statusId?: string;
  sortOrder?: number;
}

export interface WorkspaceSummary {
  total: number;
  active: number;
  idle: number;
  branches: string[];
}

export interface IssueWithStatus {
  id: string;
  title: string;
  description: string | null;
  priority: string;
  sortOrder: number;
  statusId: string;
  projectId: string;
  createdAt: string;
  updatedAt: string;
  statusName: string;
  workspaceSummary?: WorkspaceSummary;
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
}

export interface UpdateWorkspaceRequest {
  status?: "active" | "idle" | "closed";
  workingDir?: string;
}

export interface WorkspaceResponse {
  id: string;
  issueId: string;
  branch: string;
  status: string;
  workingDir: string | null;
  baseBranch: string | null;
  sessionId?: string;
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
}

export interface AgentOutputMessage {
  type: "stdout" | "stderr" | "exit";
  sessionId: string;
  data?: string;
  exitCode?: number | null;
}
