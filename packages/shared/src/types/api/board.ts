// Board-status wire-contract types (pure DTOs). See ../api.ts barrel.

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
