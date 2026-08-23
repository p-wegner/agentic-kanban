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
  /**
   * Set when this workspace's branch has committed work that exists only on a fleet worker
   * right now (#790), so `diffStats` above is the BASE TIP rather than what the agent has
   * done. The card renders `label` beside the numbers; the diff endpoint lands the work on
   * demand (#784) and shows the real thing.
   */
  remoteUnlanded?: { workerId: string; sessionId: string; label: string } | null;
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
