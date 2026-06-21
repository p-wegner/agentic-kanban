// Pure data-derivation + filter logic for AllWorkspacesPanel. Extracted from the
// component so the (previously untested) status-chip + search product rules are
// independently unit-testable; the panel imports these and renders identically.

import type { IssueWithStatus, StatusWithIssues } from "@agentic-kanban/shared";
import type { StaleWorktreeEntry } from "../hooks/useStaleWorkspaceManager.js";

export interface CrossProjectIssue {
  id: string;
  issueNumber: number | null;
  title: string;
  statusName: string;
  projectId: string;
  workspaceSummary?: IssueWithStatus["workspaceSummary"];
}

export interface CrossProjectGroup {
  projectId: string;
  projectName: string;
  issues: CrossProjectIssue[];
}

export type WsStatusFilter =
  | "all" | "active" | "running" | "idle" | "reviewing" | "fixing" | "closed" | "stale";

export type IssueWithMaybeProject = CrossProjectIssue & { projectName?: string };

/** The "active" status chip covers these three workspace states. */
const ACTIVE_STATUSES = ["active", "reviewing", "fixing"];

/**
 * Build the unified issue list for the panel. In cross-project ("all") mode this
 * flattens each project group's issues, tagging them with projectName; otherwise it
 * flattens the single project's columns and keeps only issues that have ≥1 workspace.
 */
export function selectIssuesWithWorkspaces(
  projectFilter: string,
  crossProjectData: CrossProjectGroup[] | null,
  columns: StatusWithIssues[],
): IssueWithMaybeProject[] {
  if (projectFilter === "all") {
    return (crossProjectData ?? []).flatMap((g) =>
      g.issues.map((i) => ({ ...i, projectName: g.projectName })),
    );
  }
  return columns
    .flatMap((col) => col.issues)
    .filter((issue) => issue.workspaceSummary && issue.workspaceSummary.total > 0);
}

/** Count issues whose main workspace is active / reviewing / fixing. */
export function countActiveWorkspaces(issues: IssueWithMaybeProject[]): number {
  return issues.filter((i) => ACTIVE_STATUSES.includes(i.workspaceSummary?.main?.status ?? "")).length;
}

/** The main-workspace ids of issues whose main workspace is idle (for bulk-close). */
export function collectIdleWorkspaceIds(issues: IssueWithMaybeProject[]): string[] {
  return issues
    .filter((i) => i.workspaceSummary?.main?.status === "idle")
    .map((i) => i.workspaceSummary!.main!.id);
}

/**
 * The workspace-row filter predicate: the status chip ('active' = active|reviewing|
 * fixing; 'all'/'stale' pass through; otherwise exact main-status equality) AND a
 * trimmed, case-insensitive OR over title / branch / projectName.
 */
export function matchesWorkspaceFilter(
  issue: IssueWithMaybeProject,
  statusFilter: WsStatusFilter,
  searchQuery: string,
): boolean {
  const ws = issue.workspaceSummary!;
  const mainStatus = ws.main?.status ?? "";

  if (statusFilter !== "all" && statusFilter !== "stale") {
    if (statusFilter === "active") {
      if (!ACTIVE_STATUSES.includes(mainStatus)) return false;
    } else if (mainStatus !== statusFilter) {
      return false;
    }
  }

  if (searchQuery.trim()) {
    const q = searchQuery.trim().toLowerCase();
    const matchesTitle = issue.title.toLowerCase().includes(q);
    const matchesBranch = (ws.main?.branch ?? "").toLowerCase().includes(q);
    const matchesProject = ("projectName" in issue ? (issue.projectName ?? "") : "").toLowerCase().includes(q);
    if (!matchesTitle && !matchesBranch && !matchesProject) return false;
  }

  return true;
}

/** Stale-worktree search predicate: trimmed, case-insensitive OR over branch / issue title / issue #. */
export function matchesStaleFilter(entry: StaleWorktreeEntry, searchQuery: string): boolean {
  if (!searchQuery.trim()) return true;
  const q = searchQuery.trim().toLowerCase();
  return (
    entry.branch.toLowerCase().includes(q)
    || entry.issueTitle.toLowerCase().includes(q)
    || String(entry.issueNumber).includes(q)
  );
}
