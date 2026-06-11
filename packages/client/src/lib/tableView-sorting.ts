import type { IssueWithStatus } from "@agentic-kanban/shared";

export type SortKey = "number" | "title" | "status" | "priority" | "type" | "estimate" | "updated" | "dueDate";
export type SortDir = "asc" | "desc";

export const ISSUE_TYPE_ORDER: Record<string, number> = { bug: 0, feature: 1, task: 2, chore: 3 };
export const ESTIMATE_ORDER: Record<string, number> = { XS: 0, S: 1, M: 2, L: 3, XL: 4 };
export const PRIORITY_ORDER: Record<string, number> = { critical: 0, urgent: 0, high: 1, medium: 2, low: 3 };

/** Pure comparator for one sort column. Returns a negative/zero/positive number like Array.prototype.sort expects. */
export function compareSortKey(a: IssueWithStatus, b: IssueWithStatus, key: SortKey): number {
  switch (key) {
    case "number": return (a.issueNumber ?? 0) - (b.issueNumber ?? 0);
    case "title": return a.title.localeCompare(b.title);
    case "status": return a.statusName.localeCompare(b.statusName);
    case "priority": return (PRIORITY_ORDER[a.priority ?? "medium"] ?? 2) - (PRIORITY_ORDER[b.priority ?? "medium"] ?? 2);
    case "type": return (ISSUE_TYPE_ORDER[a.issueType ?? "task"] ?? 2) - (ISSUE_TYPE_ORDER[b.issueType ?? "task"] ?? 2);
    case "estimate": return (ESTIMATE_ORDER[a.estimate ?? ""] ?? 99) - (ESTIMATE_ORDER[b.estimate ?? ""] ?? 99);
    case "updated": return new Date(a.updatedAt).getTime() - new Date(b.updatedAt).getTime();
    case "dueDate": {
      const aTime = a.dueDate ? new Date(a.dueDate).getTime() : Infinity;
      const bTime = b.dueDate ? new Date(b.dueDate).getTime() : Infinity;
      return aTime - bTime;
    }
  }
  return 0;
}

/** Negates a comparator result for descending order. */
export function applySortDirection(cmp: number, dir: SortDir): number {
  return dir === "asc" ? cmp : -cmp;
}
