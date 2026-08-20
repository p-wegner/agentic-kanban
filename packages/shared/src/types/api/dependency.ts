// Dependency-graph / dependency-wave wire-contract types (pure DTOs). See ../api.ts barrel.
import type { DependencyType } from "../../schema/index.js";

export interface DependencyItem {
  id: string;
  issueId: string;
  dependsOnId: string;
  type: DependencyType;
  createdAt: string;
  issueTitle: string;
  issueStatusName: string;
  issueNumber: number | null;
}

export interface DependencyInfo {
  dependencies: DependencyItem[];
}

export interface DependencyWaveIssue {
  id: string;
  issueNumber: number | null;
  title: string;
  statusName: string;
  startEligible: boolean;
  blockers: Array<{
    issueId: string;
    issueNumber: number | null;
    title: string;
    statusName: string;
  }>;
  reasons: string[];
}

export interface DependencyWavePlan {
  projectId: string;
  readyNow: DependencyWaveIssue[];
  blocked: DependencyWaveIssue[];
  cyclicInvalid: DependencyWaveIssue[];
  wip: {
    current: number;
    limit: number;
    available: number;
  };
}

export interface DependencyWaveStartResult {
  started: Array<{ issueId: string; issueNumber: number | null; workspaceId: string }>;
  failed: Array<{ issueId: string; issueNumber: number | null; error: string }>;
  skipped: {
    wipLimit: number;
    currentWip: number;
    availableSlots: number;
    readyButNotStarted: number;
  };
}
