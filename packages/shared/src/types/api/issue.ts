// Issue / milestone / status-column wire-contract types (pure DTOs). See ../api.ts barrel.
import type { WorkspaceSummary } from "./workspace.js";

export type IssueType = "task" | "bug" | "feature" | "chore";

export type IssueEstimate = "XS" | "S" | "M" | "L" | "XL";

export interface CreateIssueRequest {
  title: string;
  description?: string;
  priority?: "low" | "medium" | "high" | "critical";
  issueType?: IssueType;
  statusId: string;
  projectId: string;
  skipAutoReview?: boolean;
  estimate?: IssueEstimate;
  /** Optional configurable-workflow template; null/omitted = auto-route by ticket type. */
  workflowTemplateId?: string | null;
  /** Optional external-tracker identifier (e.g. "PROJ-123"). */
  externalKey?: string | null;
  /** Optional external-tracker deep link; must be http/https. */
  externalUrl?: string | null;
  /** Repos this issue touches (#94, multi-repo projects). Applied server-side as
   *  `repo:<name>` tags; omitted/empty for single-repo projects. */
  reposTouched?: string[];
}

export interface UpdateIssueRequest {
  title?: string;
  description?: string;
  priority?: "low" | "medium" | "high" | "critical";
  issueType?: IssueType;
  statusId?: string;
  sortOrder?: number;
  estimate?: IssueEstimate | null;
  skipAutoReview?: boolean;
  dueDate?: string | null;
  /** Optional external-tracker identifier (e.g. "PROJ-123"). */
  externalKey?: string | null;
  /** Optional external-tracker deep link; must be http/https. */
  externalUrl?: string | null;
  /** Acceptance-criteria checklist items. Replaces the full list when provided. */
  checklist?: { id: string; text: string; completed: boolean }[] | null;
  pinned?: boolean;
  milestoneId?: string | null;
}

export interface IssueWithStatus {
  id: string;
  issueNumber: number | null;
  title: string;
  description?: string | null;
  priority: string;
  issueType: string;
  sortOrder: number;
  statusId: string;
  projectId: string;
  createdAt: string;
  updatedAt: string;
  statusChangedAt: string | null;
  statusName: string;
  workspaceSummary?: WorkspaceSummary;
  isBlocked?: boolean;
  isStale?: boolean;
  staleDays?: number;
  columnAgeDays?: number;
  isColumnStale?: boolean;
  skipAutoReview?: boolean;
  estimate?: string | null;
  dueDate?: string | null;
  externalKey?: string | null;
  externalUrl?: string | null;
  tags?: { id: string; name: string; color: string | null }[];
  checklist?: { id: string; text: string; completed: boolean }[];
  pinned?: boolean;
  milestoneId?: string | null;
}

export interface MilestoneResponse {
  id: string;
  projectId: string;
  name: string;
  dueDate: string | null;
  createdAt: string;
}

export interface MilestoneSummaryResponse extends MilestoneResponse {
  totalIssues: number;
  openIssues: number;
  closedIssues: number;
  progressPercent: number;
  burndown: Array<{
    date: string;
    remaining: number;
    opened: number;
    closed: number;
  }>;
}

export interface StatusWithIssues {
  id: string;
  name: string;
  projectId: string;
  sortOrder: number;
  issues: IssueWithStatus[];
  /** Total issue count for this column. For terminal columns (Done/Cancelled) only the most-recent N issues are included in `issues`; `count` exposes the true total. */
  count: number;
}

export interface IssueArtifact {
  id: string;
  issueId: string;
  workspaceId: string | null;
  type: "image" | "text" | "link" | "video";
  mimeType: string | null;
  content: string;
  caption: string | null;
  createdAt: string;
}
