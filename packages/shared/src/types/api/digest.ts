// Digest-view wire DTOs (#704). See ../api.ts barrel.

export interface DigestData {
  range: DigestRange;
  since: string;
  now: string;
  created: DigestIssueRef[];
  completed: DigestIssueRef[];
  moved: DigestIssueRef[];
  merged: Array<{
    workspaceId: string;
    issueId: string;
    issueNumber: number | null;
    issueTitle: string;
    branch: string;
    closedAt: string;
  }>;
  sessions: SessionDigestEntry[];
  blocked: DigestIssueRef[];
  headline: {
    createdCount: number;
    completedCount: number;
    mergedCount: number;
    sessionCount: number;
    sessionSuccessCount: number;
    totalCostUsd: number;
    blockedCount: number;
    activeAgents: number;
  };
}

export interface DigestIssueRef {
  issueId: string;
  issueNumber: number | null;
  title: string;
  statusName: string;
  priority: string;
  issueType: string;
  at: string;
}

export interface SessionDigestEntry {
  sessionId: string;
  issueId: string;
  issueNumber: number | null;
  issueTitle: string;
  startedAt: string;
  endedAt: string | null;
  success: boolean;
  durationMs: number;
  costUsd: number;
  triggerType: string | null;
}

export type DigestRange = "24h" | "3d" | "7d";
