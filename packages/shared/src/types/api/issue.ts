// Issue / milestone / status-column wire-contract types (pure DTOs). See ../api.ts barrel.
import type { WorkspaceSummary } from "./workspace.js";

// #570: these unions are DERIVED from the runtime arrays in lib/issue-vocab.ts rather than
// declared here. The types barrel is `export type *`, so a runtime array cannot live in this
// file — which is exactly why every layer that needed one at runtime hand-listed the literals
// and then disagreed (four client selects were missing `chore`). Re-exported so every existing
// importer of `types/api/issue` keeps working.
export type { IssueType, IssueEstimate, IssueArtifactType } from "../../lib/issue-vocab.js";
import type { IssueType, IssueEstimate, IssueArtifactType } from "../../lib/issue-vocab.js";

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
  type: IssueArtifactType;
  mimeType: string | null;
  content: string;
  caption: string | null;
  createdAt: string;
}
