// Workspace-cleanup and artifact wire DTOs (#704). See ../api.ts barrel.

export interface ArtifactEntry {
  /** Relative path from the workspace workingDir */
  path: string;
  /** Artifact category */
  type: "image" | "text" | "trace" | "other";
  /** File size in bytes */
  size: number;
  /** ISO timestamp of last modification */
  modified: string;
  /** Human-readable file extension (e.g. ".png") */
  ext: string;
}

export interface CleanupWarningEntry {
  id: string;
  branch: string;
  workingDir: string | null;
  cleanupWarning: string;
  closedAt: string | null;
  mergedAt: string | null;
  updatedAt: string | null;
  issueId: string;
  issueNumber: number;
  issueTitle: string;
  projectId: string;
}

export interface StaleWorktreeEntry {
  id: string;
  branch: string;
  workingDir: string;
  workspaceStatus: string;
  closedAt: string | null;
  mergedAt: string | null;
  updatedAt: string | null;
  issueId: string;
  issueNumber: number;
  issueTitle: string;
  issueStatusName: string;
  projectId: string;
  repoPath: string;
}
