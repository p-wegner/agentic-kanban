import type { IssueWithStatus, StatusWithIssues } from "@agentic-kanban/shared";
import { TYPE_COLORS as TYPE_DOT, PRIORITY_META } from "./chartColors.js";
import { clipSpan, parseLocalDate, DAY_MS } from "./timeScale.js";

export { DAY_MS };

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

/**
 * Priority -> color, derived from the shared `chartColors.PRIORITY_META` instead of a
 * second, independently-maintained hex table (#1086 P3-a) — the timeline used to carry its
 * own saturated red/orange/yellow/gray values that disagreed with the editorial palette
 * every other data-viz view already draws from.
 */
export const PRIORITY_COLORS: Record<string, string> = Object.fromEntries(
  PRIORITY_META.map((p) => [p.key, p.color]),
);

/**
 * Display order for the priority legend (#1088 P2-7) — highest urgency first, matching the
 * order a reader scans a priority column in. Derived from `PRIORITY_META`'s own order, which
 * is already critical→high→medium→low.
 */
export const PRIORITY_ORDER: readonly string[] = PRIORITY_META.map((p) => p.key);

/**
 * Shape class for a priority dot, on top of its color (#1099 P2-10) — a sighted reader who
 * can't distinguish the four hues (low vision, color blindness, a grayscale screenshot) still
 * had nothing to go on once #1097 gave the dot an accessible name for screen readers; the
 * VISUAL affordance was still color alone. Each priority now also gets a distinct silhouette:
 * a plain square (low), a circle (medium), a diamond (high, a rotated square), and a
 * ring-bordered circle (critical, the only one with an outline of its own).
 */
export const PRIORITY_SHAPE_CLASS: Record<string, string> = {
  critical: "w-2.5 h-2.5 rounded-full ring-2 ring-white/80 dark:ring-gray-900/80",
  high: "w-2 h-2 rounded-none rotate-45",
  medium: "w-2 h-2 rounded-full",
  low: "w-2 h-2 rounded-none",
};

export const STATUS_BG: Record<string, string> = {
  "Todo":        "bg-gray-50 dark:bg-gray-900",
  "In Progress": "bg-blue-50/50 dark:bg-blue-950/20",
  "In Review":   "bg-accent-50/50 dark:bg-accent-950/20",
  "AI Reviewed": "bg-accent-50/50 dark:bg-accent-950/20",
  "Done":        "bg-green-50/50 dark:bg-green-950/20",
  "Cancelled":   "bg-gray-100/50 dark:bg-gray-800/30",
};

// #517: not folded into the status tones. These are bare TEXT colours with no background
// — the timeline draws its own row tint (STATUS_BG above) and a tone class would paint a
// second, conflicting pill background over it. Same statuses, different affordance.
export const STATUS_BADGE: Record<string, string> = {
  "Todo":        "text-gray-600 dark:text-gray-400",
  "In Progress": "text-blue-700 dark:text-blue-300",
  "In Review":   "text-accent-700 dark:text-accent-300",
  "AI Reviewed": "text-accent-700 dark:text-accent-300",
  "Done":        "text-green-700 dark:text-green-300",
  "Cancelled":   "text-gray-500 dark:text-gray-500",
};

/**
 * Opaque counterpart of `STATUS_BG` for surfaces that must not let content bleed through them
 * — the sticky lane header (#1086 P2-12). `STATUS_BG`'s own values are deliberately
 * translucent (a soft row tint over many stacked rows); stripping the `/NN` opacity suffix
 * gives the same hue at full opacity instead of a second hand-maintained color table. Falls
 * back to the shared surface color for a status with no entry (both here and in `STATUS_BG`).
 */
export const STATUS_BG_SOLID: Record<string, string> = Object.fromEntries(
  Object.entries(STATUS_BG).map(([name, cls]) => [name, cls.replace(/\/\d+/g, "")]),
);

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
export interface LaneFilter {
  showCompleted: boolean;
  activeTypes: Set<string>;
  query: string;
  /**
   * Priority filter (P2-15 remainder, #1100). Empty set means "no priority filter" —
   * matching the same convention `activeTagIds` below uses, rather than `activeTypes`'
   * "all selected = no filter" convention, since priority has no toolbar-visible "select
   * all" state to fall back to.
   */
  activePriorities?: Set<string>;
  /** Tag filter (P2-15 remainder, #1100). Empty set means "no tag filter" — an issue with
   * any one of the selected tags matches (OR, not AND), matching the board-wide tag filter's
   * own semantics in `boardFilterStore.ts`. */
  activeTagIds?: Set<string>;
}

/** Lanes per status column, filtered by completed-toggle, active types, priority, tags, and search; empty lanes dropped. */
export function computeLanes(columns: StatusWithIssues[], filter: LaneFilter): Lane[] {
  const q = filter.query;
  // A bare or `#`-prefixed issue number (#1086/#1091 P1-4) — title/description search alone
  // can't find an issue by its number, which is how people actually refer to one.
  const numberMatch = /^#?(\d+)$/.exec(q)?.[1];
  const activePriorities = filter.activePriorities;
  const activeTagIds = filter.activeTagIds;
  return columns
    .filter((col) => filter.showCompleted || !COMPLETED_STATUSES.has(col.name))
    .map((col) => ({
      name: col.name,
      issues: col.issues
        .filter((i) => {
          const type = i.issueType ?? "task";
          if (!filter.activeTypes.has(type)) return false;
          if (activePriorities && activePriorities.size > 0 && !activePriorities.has(i.priority ?? "medium")) return false;
          if (activeTagIds && activeTagIds.size > 0 && !(i.tags ?? []).some((t) => activeTagIds.has(t.id))) return false;
          if (!q) return true;
          if (numberMatch && String(i.issueNumber) === numberMatch) return true;
          return i.title.toLowerCase().includes(q) || (i.description ?? "").toLowerCase().includes(q);
        })
        // #1099 P2-15 (partial): time-ordered rows instead of raw kanban sort order, so a
        // lane reads top-to-bottom as "oldest started first" like the axis itself. Grouping
        // by epic/tag/agent is the larger remainder, tracked as a follow-up ticket rather
        // than folded in here.
        .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()),
      count: col.count,
      returnedCount: col.issues.length,
    }))
    .filter((lane) => lane.issues.length > 0);
}

/** All distinct tags present across `issues`, deduped by id, in first-seen order. */
export function collectAvailableTags(issues: IssueWithStatus[]): { id: string; name: string; color: string | null }[] {
  const seen = new Map<string, { id: string; name: string; color: string | null }>();
  for (const issue of issues) {
    for (const tag of issue.tags ?? []) {
      if (!seen.has(tag.id)) seen.set(tag.id, { id: tag.id, name: tag.name, color: tag.color ?? null });
    }
  }
  return [...seen.values()];
}

/** Toggle a member of a set with no other special-casing — for tags, where there is no
 * meaningful "all selected" state to reset to (unlike `toggleTypeSet`'s fixed universe). */
export function toggleSetMember(prev: Set<string>, id: string): Set<string> {
  const next = new Set(prev);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  return next;
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

/** Below this many points, percentile trimming would drop a meaningful fraction of the data — keep the exact min/max instead. */
const MIN_POINTS_FOR_TRIM = 8;
/** Fraction of points dropped from EACH end when trimming (10% total). */
const TRIM_FRACTION = 0.05;

/**
 * A robust [min,max] over `values`, dropping the extreme ends once there are enough points to
 * make percentile trimming meaningful (#1088/#1099 P2-13). The initial "fit all" viewport used
 * to be a raw min/max over every issue's dates — a single old Cancelled issue (or one due a
 * year out) could leave ~90% of the canvas empty for everything else. Trimming the tails
 * instead means the default view fits the CLUSTER most issues actually sit in; callers that
 * want the literal extremes (e.g. checking whether a value is itself an outlier) should use
 * `values` directly rather than this.
 */
export function robustRange(values: number[]): { min: number; max: number } {
  if (values.length === 0) return { min: 0, max: 0 };
  const sorted = [...values].sort((a, b) => a - b);
  if (sorted.length < MIN_POINTS_FOR_TRIM) {
    return { min: sorted[0], max: sorted[sorted.length - 1] };
  }
  const cut = Math.floor(sorted.length * TRIM_FRACTION);
  return { min: sorted[cut], max: sorted[sorted.length - 1 - cut] };
}

/** Minimum pixel width a major tick's label needs before two adjacent labels start to crowd. */
const MIN_LABEL_PX = 70;

/**
 * How many major ticks to skip between rendered LABELS at a given track width (#1099 P2-20) —
 * the gridlines themselves are unaffected; only the text is thinned. At the full label density
 * a narrow viewport (a sidebar-docked window, a phone) would either wrap, truncate, or overlap
 * every other date; showing every Nth one instead keeps each label readable and unambiguous
 * (still anchored to a real tick, not interpolated).
 */
export function computeLabelStride(tickCount: number, trackPx: number): number {
  if (tickCount <= 0 || trackPx <= 0) return 1;
  return Math.max(1, Math.ceil((MIN_LABEL_PX * tickCount) / trackPx));
}
