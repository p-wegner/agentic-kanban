// Flake-classifier wire-contract types (pure DTOs). See ../api.ts barrel.

export type FlakeDecision = "flake" | "suspicious" | "real";
export type FinalOutcome = "confirmed_flake" | "confirmed_real" | "pending";

export interface FlakyTestEntry {
  id: string;
  projectId: string;
  testName: string;
  testFilePath: string | null;
  errorPattern: string | null;
  reason: string | null;
  createdAt: string;
}

export interface CreateFlakyTestRequest {
  testName: string;
  testFilePath?: string;
  errorPattern?: string;
  reason?: string;
}

export interface RetryDecision {
  id: string;
  sessionId: string;
  workspaceId: string;
  testName: string;
  decision: FlakeDecision;
  confidence: number;
  retryCount: number;
  finalOutcome: FinalOutcome;
  reasoning: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ClassifyTestRequest {
  testName: string;
  errorMessage?: string;
  stackTrace?: string;
  changedFiles?: string[];
  testFilePath?: string;
  sessionId: string;
  workspaceId: string;
}

export interface ClassifyTestResponse {
  decision: FlakeDecision;
  confidence: number;
  reasoning: string;
  matchedFlakyTestId?: string;
  changesOverlapWithSubject: boolean;
  decisionId: string;
}

export interface FalseFlakeTelemetry {
  total: number;
  confirmedReal: number;
  confirmedFlake: number;
  pending: number;
  falseFlakeRate: number;
}
