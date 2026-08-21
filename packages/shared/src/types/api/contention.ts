// File-contention wire DTOs (#704). See ../api.ts barrel.

export interface ContentionFile {
  path: string;
  workspaces: ContentionWorkspace[];
}

export interface ContentionWorkspace {
  workspaceId: string;
  issueId: string;
  issueNumber: number | null;
  issueTitle: string;
  branch: string;
  status: string;
  issueStatus: string;
}
