import type { IssueWithStatus, StatusWithIssues } from "@agentic-kanban/shared";
import { TYPE_COLORS as TYPE_DOT } from "./chartColors.js";
import { clipSpan, parseLocalDate } from "./timeScale.js";

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

/**
 * Display order for the priority legend (#1088 P2-7) — highest urgency first, matching the
 * order a reader scans a priority column in. `PRIORITY_COLORS`'s own key order already
 * happens to match this, but that is an implementation detail of an object literal, not a
 * contract; the legend imports this explicitly instead of relying on it.
 */
export const PRIORITY_ORDER = ["critical", "high", "medium", "low"] as const;

export const STATUS_BG: Record<string, string> = {
  "Todo":        "bg-gray-50 dark:bg-gray-900",
  "In Progress": "bg-blue-50/50 dark:bg-blue-950/20",
  "In Review":   "bg-accent-50/50 dark:bg-accent-950/20",
  "AI Reviewed": "bg-accent-50/50 dark:bg-accent-950/20",
  "Done":        "bg-green-50/50 dark:bg-green-950/20",
  "Cancelled":   "bg-gray-100/50 dark:bg-gray-800/30",
};

// #517: not folded into the status tones. These are bare TEXT colours with no background
// — the timeline draws its own row tint (STATUS_ROW above) and a tone class would paint a
// second, conflicting pill background over it. Same statuses, different affordance.
export const STATUS_BADGE: Record<string, string> = {
  "Todo":        "text-gray-600 dark:text-gray-400",
  "In Progress": "text-blue-700 dark:text-blue-300",
  "In Review":   "text-accent-700 dark:text-accent-300",
  "AI Reviewed": "text-accent-700 dark:text-accent-300",
  "Done":        "text-green-700 dark:text-green-300",
  "Cancelled":   "text-gray-500 dark:text-gray-500",
};

export const DAY_MS = 86_400_000;

export const COMPLETED_STATUSES = new Set(["Done", "Cancelled"]);
export const ALL_TYPES = Object.keys(TYPE_COLORS);

export function fmtTooltipDate(d: Date): string {
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

export interface DateRange { min: number; max: number }
export interface Lane {
  name: string;
  issues: IssueWithStatus[];
  /** The column's TRUE total (#1086 P1-3) — server-side terminal columns cap `issues` at 50. */
  count: number;
  /** How many issues the server actually returned for this column, before client-side filtering. `count > returnedCount` means the server truncated it. */
  returnedCount: number;
}
export interface LaneFilter { showCompleted: boolean; activeTypes: Set<string>; query: string }

/** Lanes per status column, filtered by completed-toggle, active types, and search; empty lanes dropped. */
export function computeLanes(columns: StatusWithIssues[], filter: LaneFilter): Lane[] {
  const q = filter.query;
  // A bare or `#`-prefixed issue number (#1086/#1091 P1-4) — title/description search alone
  // can't find an issue by its number, which is how people actually refer to one.
  const numberMatch = /^#?(\d+)$/.exec(q)?.[1];
  return columns
    .filter((col) => filter.showCompleted || !COMPLETED_STATUSES.has(col.name))
    .map((col) => ({
      name: col.name,
      issues: col.issues.filter((i) => {
        const type = i.issueType ?? "task";
        if (!filter.activeTypes.has(type)) return false;
        if (!q) return true;
        if (numberMatch && String(i.issueNumber) === numberMatch) return true;
        return i.title.toLowerCase().includes(q) || (i.description ?? "").toLowerCase().includes(q);
      }),
      count: col.count,
      returnedCount: col.issues.length,
    }))
    .filter((lane) => lane.issues.length > 0);
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
  /**
   * Percent position of the bar's visible (clipped) start, or `null` when `[start,end]`
   * doesn't overlap the visible window at all — the caller draws no bar for that issue (#1086
   * P1-1). Computed via `clipSpan` against `range` treated as a 0-100 track, so the values are
   * already clamped and never need a CSS-side min/max dance.
   */
  startPct: number | null;
  spanPct: number;
  /** The bar's true start (or end) lies before (after) the visible window — draw a "continues" edge marker. */
  clippedStart: boolean;
  clippedEnd: boolean;
  type: string;
  colors: TypeColor;
  priorityColor: string;
  /**
   * `dueDate` is set but predates `createdAt` — a data problem, not a real (negative) span
   * (#1088 P1-2). A caller must render this visually distinct from an honest bar, since
   * silently ignoring a broken due date would make it look like there never was one.
   */
  invalidDueDate: boolean;
  /**
   * Percent position of a valid due-date MARKER (#1086 P1-2 remainder A) — the due date is no
   * longer the bar's end, since that made an issue due next week look already-finished-by-then.
   * `null` when there is no valid due date, or it falls outside the visible window.
   */
  duePct: number | null;
  /** Not completed — the bar's end is "now", not a fixed date, and keeps growing every day it stays open. */
  isOpen: boolean;
}

/**
 * The horizontal bar geometry + colors for one issue on the timeline.
 *
 * The bar's END is, in priority order:
 *  1. For a COMPLETED issue, `statusChangedAt` — when it actually left the board — falling
 *     back to `updatedAt` for rows stamped before that column existed.
 *  2. For an OPEN issue, `nowMs`. An open issue's bar must keep growing every day it stays
 *     open; ending it at `updatedAt` (the old rule) froze it at whenever it was last edited,
 *     which made an untouched-for-weeks open issue look like it had been done for weeks.
 *
 * A due date (if present and valid) is a separate MARKER, not the bar's end (#1086 P1-2
 * remainder A) — conflating the two made an issue due next month look already finished today.
 */
export function computeIssueBar(
  issue: IssueWithStatus,
  range: DateRange,
  isCompleted: boolean,
  nowMs: number = Date.now(),
): IssueBar {
  const start = new Date(issue.createdAt).getTime();
  // `dueDate` is a bare "YYYY-MM-DD" (an HTML `<input type="date">`), not a full timestamp —
  // `parseLocalDate` reads it as local midnight so it doesn't silently shift a day earlier in
  // any timezone west of UTC, the same fix IssueCard/IssueMetadataGrid already apply.
  const dueTs = issue.dueDate ? parseLocalDate(issue.dueDate).getTime() : null;
  const invalidDueDate = dueTs !== null && dueTs < start;
  const end = isCompleted ? new Date(issue.statusChangedAt ?? issue.updatedAt).getTime() : nowMs;
  // `range` is the visible window; treating it as a 0-100 "track" lets `clipSpan`'s pixel
  // geometry double as percentage geometry, so the bar is clamped/clipped for free instead of
  // via ad hoc CSS min()/max() (#1086 P1-1).
  const clipped = clipSpan(start, end, range, 100);
  const type = issue.issueType ?? "task";
  const duePct = dueTs !== null && !invalidDueDate && dueTs >= range.min && dueTs <= range.max
    ? pctOf(dueTs, range)
    : null;
  return {
    startPct: clipped ? clipped.x : null,
    spanPct: clipped ? clipped.width : 0,
    clippedStart: clipped?.clippedStart ?? false,
    clippedEnd: clipped?.clippedEnd ?? false,
    type,
    colors: TYPE_COLORS[type] ?? TYPE_COLORS.task,
    priorityColor: PRIORITY_COLORS[issue.priority ?? "medium"] ?? PRIORITY_COLORS.medium,
    invalidDueDate,
    duePct,
    isOpen: !isCompleted,
  };
}
