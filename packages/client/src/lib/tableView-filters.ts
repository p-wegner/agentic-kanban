import type { IssueWithStatus } from "@agentic-kanban/shared";
import { getLocalDateKey } from "./dateKey.js";

export const ARCHIVE_STATUSES = new Set(["Done", "Cancelled"]);

export interface FilterOptions {
  statusFilter: string;
  searchQuery?: string;
  createdDateFilter?: string | null;
}

/** Pure table filter: status dropdown ("active" / "all" / a status name), created-date chip, and text search. */
export function filterIssues(issues: IssueWithStatus[], { statusFilter, searchQuery, createdDateFilter }: FilterOptions): IssueWithStatus[] {
  const q = searchQuery?.toLowerCase() ?? "";
  return issues.filter((issue) => {
    if (statusFilter === "active" && ARCHIVE_STATUSES.has(issue.statusName)) return false;
    if (statusFilter !== "active" && statusFilter !== "all" && issue.statusName !== statusFilter) return false;
    if (createdDateFilter && getLocalDateKey(issue.createdAt) !== createdDateFilter) return false;
    if (q) return issue.title.toLowerCase().includes(q) || (issue.description ?? "").toLowerCase().includes(q);
    return true;
  });
}
