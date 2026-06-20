import type { IssueWithStatus } from "@agentic-kanban/shared";

// Pure cell view-model for TableView rows: the badge label/class lookups, date
// formatting, and the overdue rule. Extracted from TableView.tsx so the row
// derivation (esp. the overdue date logic) is unit-testable and TableRow shrinks
// to layout. Sort/filter/bulk logic already live in their own tableView-* libs.

export const ISSUE_TYPE_LABEL: Record<string, string> = {
  task: "Task",
  bug: "Bug",
  feature: "Feature",
  chore: "Chore",
};

export const ISSUE_TYPE_CLASS: Record<string, string> = {
  task: "text-gray-600 bg-gray-100",
  bug: "text-red-700 bg-red-50",
  feature: "text-brand-700 bg-brand-50 dark:text-brand-300 dark:bg-brand-900/40",
  chore: "text-amber-700 bg-amber-50",
};

export const STATUS_CLASS: Record<string, string> = {
  "Todo": "text-gray-600 bg-gray-100",
  "In Progress": "text-blue-700 bg-blue-50",
  "In Review": "text-accent-700 bg-accent-50 dark:text-accent-300 dark:bg-accent-900/40",
  "AI Reviewed": "text-accent-700 bg-accent-50 dark:text-accent-300 dark:bg-accent-900/40",
  "Done": "text-green-700 bg-green-50",
  "Cancelled": "text-gray-500 bg-gray-100",
};

export const PRIORITY_LABEL: Record<string, string> = { critical: "Critical", urgent: "Urgent", high: "High", medium: "Medium", low: "Low" };

export const PRIORITY_CLASS: Record<string, string> = {
  critical: "text-red-700 bg-red-50",
  urgent: "text-red-700 bg-red-50",
  high: "text-orange-700 bg-orange-50",
  medium: "text-yellow-700 bg-yellow-50",
  low: "text-gray-500 bg-gray-100",
};

export const TAG_COLORS: Record<string, string> = {
  blue: "bg-blue-100 text-blue-700",
  green: "bg-green-100 text-green-700",
  red: "bg-red-100 text-red-700",
  yellow: "bg-yellow-100 text-yellow-700",
  purple: "bg-brand-100 text-brand-700 dark:bg-brand-900/40 dark:text-brand-300",
  pink: "bg-pink-100 text-pink-700",
  orange: "bg-orange-100 text-orange-700",
  indigo: "bg-indigo-100 text-indigo-700",
  gray: "bg-gray-100 text-gray-600",
};

const STATUS_FALLBACK = "text-gray-600 bg-gray-100";

export function tagClass(color: string | null | undefined): string {
  return TAG_COLORS[color ?? ""] ?? "bg-gray-100 text-gray-600";
}

export function formatTableDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

/** A due date is overdue if it's before today AND the issue isn't already completed. */
export function isOverdue(issue: Pick<IssueWithStatus, "dueDate" | "statusName">, now: Date = new Date()): boolean {
  if (!issue.dueDate) return false;
  const today = new Date(now.toDateString());
  return new Date(issue.dueDate) < today && issue.statusName !== "Done" && issue.statusName !== "Cancelled";
}

export interface RowCells {
  statusClass: string;
  priority: string;
  priorityClass: string;
  priorityLabel: string;
  type: string;
  typeClass: string;
  typeLabel: string;
  updatedText: string;
  due: { text: string; overdue: boolean } | null;
  tags: { id: string; name: string; className: string }[];
}

/** Derive all display values for one table row from an issue. */
export function resolveRowCells(issue: IssueWithStatus, now: Date = new Date()): RowCells {
  const priority = issue.priority ?? "medium";
  const type = issue.issueType ?? "task";
  return {
    statusClass: STATUS_CLASS[issue.statusName] ?? STATUS_FALLBACK,
    priority,
    priorityClass: PRIORITY_CLASS[priority] ?? PRIORITY_CLASS.medium,
    priorityLabel: PRIORITY_LABEL[priority] ?? priority,
    type,
    typeClass: ISSUE_TYPE_CLASS[type] ?? "",
    typeLabel: ISSUE_TYPE_LABEL[type] ?? type,
    updatedText: formatTableDate(issue.updatedAt),
    due: issue.dueDate ? { text: formatTableDate(issue.dueDate), overdue: isOverdue(issue, now) } : null,
    tags: (issue.tags ?? []).map((tag) => ({ id: tag.id, name: tag.name, className: tagClass(tag.color) })),
  };
}
