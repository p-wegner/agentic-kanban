// Workspace-risk and failure-pattern wire DTOs (#704). See ../api.ts barrel.

export interface PatternMatch {
  pattern: FailurePattern;
  score: number;
  matchedKeywords: string[];
}

export type RiskLevel = "high" | "medium" | "low" | "none";

export interface RiskSignal {
  key: string;
  label: string;
  value: string | number | boolean | null;
  severity: "high" | "medium" | "low" | "none";
  detail?: string;
}

export interface WorkspaceRiskEntry {
  workspaceId: string;
  issueId: string;
  issueNumber: number | null;
  issueTitle: string;
  issueStatusName: string;
  branch: string;
  workspaceStatus: string;
  riskLevel: RiskLevel;
  riskScore: number;
  signals: RiskSignal[];
  /** Changed files for this workspace (used for overlap computation) */
  changedFiles: string[];
}

export interface WorkspaceRiskResponse {
  projectId: string;
  generatedAt: string;
  entries: WorkspaceRiskEntry[];
}

export interface FailurePattern {
  id: string;
  title: string;
  errorClass: string | null;
  keywords: string;
  description: string | null;
  rootCause: string | null;
  fix: string | null;
  sourceType: string;
  sourceRef: string | null;
  createdAt: string;
  updatedAt: string;
}
