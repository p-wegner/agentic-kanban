// One priority table for the client (#516).
//
// Priority was enumerated by hand in eleven places with four different shapes: sort
// order, label, tailwind classes (light-only in one, dark-aware in another), and raw
// hex for the charts. They disagreed about which values exist — `PRIORITY_ORDER` listed
// `urgent`, `priorityColors` and `PRIORITY_LANE_STYLES` did not — so an `urgent` issue
// sorted at the top and rendered unstyled in the "ungrouped" lane.
//
// The root cause of `urgent` is fixed server-side (#516): the decompose path now folds
// it to `critical` via `normalizeIssuePriority`, so it is a legacy INPUT alias, not a
// priority. This table therefore has exactly four rows. Anything that reads a stored
// priority should normalise first rather than adding a fifth.

import { ISSUE_PRIORITIES, normalizeIssuePriority, type IssuePriority } from "@agentic-kanban/shared/lib/issue-priority";

export { ISSUE_PRIORITIES, normalizeIssuePriority };
export type { IssuePriority };

export interface PriorityTraits {
  /** Sort rank; lower sorts first. */
  order: number;
  label: string;
  /** Badge classes, dark-mode aware. */
  badgeClass: string;
  /** Light-only badge classes, for surfaces that never render dark (table cells). */
  badgeClassLight: string;
  /** Raw hex, for charts and SVG where tailwind classes do not apply. */
  hex: string;
  /** Lane header styling for the priority-grouped board. */
  lane: { headerBg: string; headerBorder: string; headerText: string; dot: string };
}

export const PRIORITY_TRAITS: Record<IssuePriority, PriorityTraits> = {
  critical: {
    order: 0,
    label: "Critical",
    badgeClass: "bg-red-100 dark:bg-red-900/50 text-red-700 dark:text-red-300",
    badgeClassLight: "text-red-700 bg-red-50",
    hex: "#ef4444",
    lane: {
      headerBg: "bg-red-50 dark:bg-red-950/40",
      headerBorder: "border-red-200 dark:border-red-800",
      headerText: "text-red-700 dark:text-red-400",
      dot: "bg-red-500",
    },
  },
  high: {
    order: 1,
    label: "High",
    badgeClass: "bg-orange-100 dark:bg-orange-900/50 text-orange-700 dark:text-orange-300",
    badgeClassLight: "text-orange-700 bg-orange-50",
    hex: "#f97316",
    lane: {
      headerBg: "bg-orange-50 dark:bg-orange-950/40",
      headerBorder: "border-orange-200 dark:border-orange-800",
      headerText: "text-orange-700 dark:text-orange-400",
      dot: "bg-orange-500",
    },
  },
  medium: {
    order: 2,
    label: "Medium",
    badgeClass: "bg-yellow-100 dark:bg-yellow-900/50 text-yellow-700 dark:text-yellow-300",
    badgeClassLight: "text-yellow-700 bg-yellow-50",
    hex: "#eab308",
    lane: {
      headerBg: "bg-yellow-50 dark:bg-yellow-950/40",
      headerBorder: "border-yellow-200 dark:border-yellow-800",
      headerText: "text-yellow-700 dark:text-yellow-400",
      dot: "bg-yellow-400",
    },
  },
  low: {
    order: 3,
    label: "Low",
    badgeClass: "bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-400",
    badgeClassLight: "text-gray-500 bg-gray-100",
    hex: "#94a3b8",
    lane: {
      headerBg: "bg-slate-50 dark:bg-slate-800/40",
      headerBorder: "border-slate-200 dark:border-slate-700",
      headerText: "text-slate-600 dark:text-slate-400",
      dot: "bg-slate-400",
    },
  },
};

/** Traits for a possibly-legacy stored value; folds aliases (e.g. "urgent"). */
export function priorityTraits(raw: string | null | undefined): PriorityTraits {
  return PRIORITY_TRAITS[normalizeIssuePriority(raw)];
}

/** Sort rank for a possibly-legacy stored value. */
export function priorityOrder(raw: string | null | undefined): number {
  return priorityTraits(raw).order;
}

/** Display label for a possibly-legacy stored value. */
export function priorityLabel(raw: string | null | undefined): string {
  return priorityTraits(raw).label;
}

/**
 * "Important enough to plan first" — the `high || critical` predicate that decides
 * whether a new workspace opens in plan mode. It was duplicated at
 * CreateWorkspaceForm and createBoardIssueActions; if the set ever changes, it must
 * change in one place or the form and the board action disagree about the SAME issue.
 */
export function isPlanModePriority(raw: string | null | undefined): boolean {
  const p = normalizeIssuePriority(raw);
  return p === "critical" || p === "high";
}
