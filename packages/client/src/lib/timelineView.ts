import type { IssueWithStatus, StatusWithIssues } from "@agentic-kanban/shared";
import { TYPE_COLORS as TYPE_DOT } from "./chartColors.js";

// Pure view-model for TimelineView: config maps, lane filtering, date-range +
// tick math, and per-issue bar positioning. No JSX/hooks, so the date/tick/lane
// edge cases (empty set, label dedup, last-type-toggle reset, padding) are
// directly unit-testable. Extracted from TimelineView.tsx (component CC 23).

export interface TypeColor { bg: string; border: string; text: string; dot: string }

export const TYPE_COLORS: Record<string, TypeColor> = {
  task:    { bg: "bg-slate-100 dark:bg-slate-800/50",  border: "border-slate-300 dark:border-slate-600",  text: "text-slate-700 dark:text-slate-200",  dot: TYPE_DOT.task },
  bug:     { bg: "bg-red-100 dark:bg-red-900/50",      border: "border-red-300 dark:border-red-700",      text: "text-red-800 dark:text-red-200",      dot: TYPE_DOT.bug },
  feature: { bg: "bg-brand-100 dark:bg-brand-900/50", border: "border-brand-300 dark:border-brand-700", text: "text-brand-800 dark:text-brand-200", dot: TYPE_DOT.feature },
  chore:   { bg: "bg-amber-100 dark:bg-amber-900/50",  border: "border-amber-300 dark:border-amber-700",  text: "text-amber-800 dark:text-amber-200",  dot: TYPE_DOT.chore },
};

export const PRIORITY_COLORS: Record<string, string> = {
  critical: "#ef4444",
  high:     "#f97316",
  medium:   "#eab308",
  low:      "#6b7280",
};

export const STATUS_BG: Record<string, string> = {
  "Todo":        "bg-gray-50 dark:bg-gray-900",
  "In Progress": "bg-blue-50/50 dark:bg-blue-950/20",
  "In Review":   "bg-accent-50/50 dark:bg-accent-950/20",
  "AI Reviewed": "bg-accent-50/50 dark:bg-accent-950/20",
  "Done":        "bg-green-50/50 dark:bg-green-950/20",
  "Cancelled":   "bg-gray-100/50 dark:bg-gray-800/30",
};

export const STATUS_BADGE: Record<string, string> = {
  "Todo":        "text-gray-600 dark:text-gray-400",
  "In Progress": "text-blue-700 dark:text-blue-300",
  "In Review":   "text-accent-700 dark:text-accent-300",
  "AI Reviewed": "text-accent-700 dark:text-accent-300",
  "Done":        "text-green-700 dark:text-green-300",
  "Cancelled":   "text-gray-500 dark:text-gray-500",
};

export const DAY_MS = 86_400_000;
export const WEEK_MS = 7 * DAY_MS;
export const MONTH_MS = 30 * DAY_MS;

export const COMPLETED_STATUSES = new Set(["Done", "Cancelled"]);
export const ALL_TYPES = Object.keys(TYPE_COLORS);

export function fmtAxisDate(d: Date, spanMs: number): string {
  if (spanMs < 2 * DAY_MS) {
    // Sub-2-day span: show time so adjacent ticks are distinguishable
    return d.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" });
  }
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

export function fmtTooltipDate(d: Date): string {
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

export interface DateRange { min: number; max: number }
export interface Lane { name: string; issues: IssueWithStatus[] }
export interface LaneFilter { showCompleted: boolean; activeTypes: Set<string>; query: string }

/** Lanes per status column, filtered by completed-toggle, active types, and search; empty lanes dropped. */
export function computeLanes(columns: StatusWithIssues[], filter: LaneFilter): Lane[] {
  const q = filter.query;
  return columns
    .filter((col) => filter.showCompleted || !COMPLETED_STATUSES.has(col.name))
    .map((col) => ({
      name: col.name,
      issues: col.issues.filter((i) => {
        const type = i.issueType ?? "task";
        if (!filter.activeTypes.has(type)) return false;
        return !q || i.title.toLowerCase().includes(q) || (i.description ?? "").toLowerCase().includes(q);
      }),
    }))
    .filter((lane) => lane.issues.length > 0);
}

/** The unpanned [min,max] time window over all issues (created → due/updated), padded 4%. */
export function computeBaseRange(allIssues: IssueWithStatus[]): DateRange {
  if (allIssues.length === 0) {
    const now = Date.now();
    return { min: now - 7 * DAY_MS, max: now };
  }
  const dates = allIssues.flatMap((i) => [
    new Date(i.createdAt).getTime(),
    i.dueDate ? new Date(i.dueDate).getTime() : new Date(i.updatedAt).getTime(),
  ]);
  const rawMin = Math.min(...dates);
  const rawMax = Math.max(...dates, Date.now());
  const span = Math.max(rawMax - rawMin, DAY_MS); // at least 1 day
  const pad = span * 0.04;
  return { min: rawMin - pad, max: rawMax + pad };
}

/** Evenly-spaced axis ticks (4–10 by span), dropping adjacent ticks with identical labels. */
export function computeTicks(range: DateRange): Date[] {
  const span = range.max - range.min;
  const days = span / DAY_MS;
  const count = Math.min(10, Math.max(4, Math.floor(days / 3)));
  const raw = Array.from({ length: count + 1 }, (_, i) => new Date(range.min + (i / count) * span));
  const deduped: Date[] = [];
  let lastLabel = "";
  for (const tick of raw) {
    const label = fmtAxisDate(tick, span);
    if (label !== lastLabel) {
      deduped.push(tick);
      lastLabel = label;
    }
  }
  return deduped;
}

/** A timestamp's horizontal position within the range, as a 0–100 percentage. */
export function pctOf(ts: number, range: DateRange): number {
  return ((ts - range.min) / (range.max - range.min)) * 100;
}

/** Toggle a type filter, resetting to all-types when the last active type would be removed. */
export function toggleTypeSet(prev: Set<string>, type: string): Set<string> {
  const next = new Set(prev);
  if (next.has(type)) {
    if (next.size === 1) return new Set(ALL_TYPES);
    next.delete(type);
  } else {
    next.add(type);
  }
  return next;
}

export interface IssueBar {
  startPct: number;
  spanPct: number;
  type: string;
  colors: TypeColor;
  priorityColor: string;
}

/** The horizontal bar geometry + colors for one issue on the timeline. */
export function computeIssueBar(issue: IssueWithStatus, range: DateRange): IssueBar {
  const start = new Date(issue.createdAt).getTime();
  const end = issue.dueDate ? new Date(issue.dueDate).getTime() : new Date(issue.updatedAt).getTime();
  const startPct = pctOf(start, range);
  const type = issue.issueType ?? "task";
  return {
    startPct,
    spanPct: Math.max(0, pctOf(end, range) - startPct),
    type,
    colors: TYPE_COLORS[type] ?? TYPE_COLORS.task,
    priorityColor: PRIORITY_COLORS[issue.priority ?? "medium"] ?? PRIORITY_COLORS.medium,
  };
}
