// Diff / diff-comment / merged-commit wire-contract types (pure DTOs). See ../api.ts barrel.

export interface DiffResponse {
  diff: string;
  stats: {
    filesChanged: number;
    insertions: number;
    deletions: number;
  };
  comments: DiffComment[];
  conflicts?: { hasConflicts: boolean; conflictingFiles: string[] } | null;
  /**
   * Multi-repo workspaces only: per-repo diff sections (leading repo first). The
   * top-level `diff`/`stats` aggregate across all repos; single-repo workspaces
   * omit this field entirely so their response is unchanged.
   */
  repos?: Array<{
    name: string | null;
    path: string;
    diff: string;
    stats: { filesChanged: number; insertions: number; deletions: number };
    conflicts?: { hasConflicts: boolean; conflictingFiles: string[] } | null;
  }>;
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

/** One commit that landed on the default branch for an issue's merged workspace. */
export interface MergedCommit {
  sha: string;
  shortSha: string;
  message: string;
  author: string;
  /** Author date, ISO-8601. */
  date: string;
  /** The workspace branch this commit landed via. */
  branch: string;
  /** The merged workspace's id (for the diff link). */
  workspaceId: string;
}

/** Response for GET /api/issues/:id/merged-commits. */
export interface MergedCommitsResponse {
  /** True once at least one of the issue's workspaces has been merged. */
  merged: boolean;
  /** The default (base) branch the commits landed on. */
  defaultBranch: string | null;
  /** Commits across all merged workspaces for the issue, newest first. */
  commits: MergedCommit[];
}
