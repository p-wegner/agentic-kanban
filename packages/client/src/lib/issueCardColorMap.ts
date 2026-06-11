import type { IssueWithStatus } from "@agentic-kanban/shared";

export const priorityColors: Record<string, string> = {
  critical: "bg-red-100 dark:bg-red-900/50 text-red-700 dark:text-red-300",
  high: "bg-orange-100 dark:bg-orange-900/50 text-orange-700 dark:text-orange-300",
  medium: "bg-yellow-100 dark:bg-yellow-900/50 text-yellow-700 dark:text-yellow-300",
  low: "bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-400",
};

export function coverageClass(pct: number): string {
  if (pct >= 80) return "bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300";
  if (pct >= 60) return "bg-yellow-100 text-yellow-700 dark:bg-yellow-900/40 dark:text-yellow-300";
  return "bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300";
}

export function commitCountClass(count: number): string {
  if (count <= 0) return "bg-gray-100 text-gray-500 dark:bg-gray-800 dark:text-gray-400";
  if (count <= 3) return "bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300";
  if (count <= 10) return "bg-yellow-100 text-yellow-700 dark:bg-yellow-900/40 dark:text-yellow-300";
  return "bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300";
}

export type WorkflowSnapshot = NonNullable<
  NonNullable<NonNullable<IssueWithStatus["workspaceSummary"]>["main"]>["workflow"]
>;

export const workflowStateClasses: Record<WorkflowSnapshot["state"], string> = {
  active: "border-blue-200 bg-blue-50 text-blue-700 dark:border-blue-800 dark:bg-blue-900/30 dark:text-blue-300",
  waiting: "border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-800 dark:bg-amber-900/30 dark:text-amber-300",
  terminal: "border-green-200 bg-green-50 text-green-700 dark:border-green-800 dark:bg-green-900/30 dark:text-green-300",
};

export const workflowDotClasses: Record<WorkflowSnapshot["state"], string> = {
  active: "bg-blue-500",
  waiting: "bg-amber-500",
  terminal: "bg-green-500",
};
