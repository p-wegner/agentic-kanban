import type { IssueWithStatus } from "@agentic-kanban/shared";

const issueTypeColors: Record<string, string> = {
  task: "bg-blue-100 dark:bg-blue-900/50 text-blue-800 dark:text-blue-200",
  bug: "bg-red-100 dark:bg-red-900/50 text-red-800 dark:text-red-200",
  feature: "bg-brand-50 dark:bg-brand-900/40 text-brand-700 dark:text-brand-300",
  chore: "bg-amber-100 dark:bg-amber-900/50 text-amber-800 dark:text-amber-200",
};

const DEFAULT_ISSUE_TYPE = "task";
const DEFAULT_ISSUE_TYPE_CLASS = "bg-gray-200 dark:bg-gray-700 text-gray-700 dark:text-gray-300";

export interface IssueDisplayData {
  issueType: string;
  issueTypeClassName: string;
}

/**
 * Shared issue-display derivation consumed by both IssueCard and
 * IssueDetailPanel. Centralizing it here means future changes to how an
 * issue's type/badge is derived touch only this hook — the two components
 * stay decoupled instead of changing together (#645).
 */
export function useIssueDisplayData(issue: IssueWithStatus): IssueDisplayData {
  const issueType = issue.issueType ?? DEFAULT_ISSUE_TYPE;
  return {
    issueType,
    issueTypeClassName: issueTypeColors[issueType] ?? DEFAULT_ISSUE_TYPE_CLASS,
  };
}
