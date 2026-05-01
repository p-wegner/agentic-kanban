// API request/response types

export interface CreateProjectRequest {
  name: string;
  description?: string;
  color?: string;
}

export interface UpdateProjectRequest {
  name?: string;
  description?: string;
  color?: string;
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
  createdAt: string;
  updatedAt: string;
}

export interface WorkspaceWithIssue extends WorkspaceResponse {
  issue: {
    title: string;
    priority: string;
  };
}
