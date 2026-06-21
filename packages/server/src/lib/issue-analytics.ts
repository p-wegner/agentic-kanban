import { isTerminalStatusName } from "@agentic-kanban/shared";

/**
 * Pure aggregation core for the board's time-series analytics charts
 * (burndown / CFD / throughput / lead-time).
 *
 * WHY THIS EXISTS
 * These computations used to live inline in `routes/issues.ts` — a transport
 * adapter doing application work. Each handler independently re-derived the same
 * "build a YYYY-MM-DD date axis from a cutoff up to today" loop and then bucketed
 * rows by day. That made the hottest-churn route file in the server (#issues.ts)
 * carry the project's heaviest route handlers (CC 17/11/11) and left the actual
 * math untestable without spinning up an HTTP server + DB.
 *
 * Everything here is PURE: it takes already-fetched rows + a window length +
 * an injected `now`, and returns the exact response DTOs the routes emit. No DB,
 * no `new Date()` ambiguity — so the bucketing logic is unit-testable with plain
 * arrays, and reusable by any inbound adapter (HTTP route, CLI, MCP).
 *
 * `now` is snapshotted once by the caller so the cutoff and the date axis stay
 * consistent even if a query crosses midnight (the burndown handler always did
 * this deliberately; the others now inherit that correctness for free).
 *
 * YYYY-MM-DD strings compare lexicographically == chronologically, which is why
 * day comparisons below use plain string `<=` / `>` instead of Date math.
 */

/** Row shape from `getIssueStatusTimelineRows` — backs burndown + CFD. */
export interface StatusTimelineRow {
  createdAt: string;
  statusChangedAt: string | null;
  statusName: string;
  statusSortOrder: number;
}

/** Row shape from `getDoneIssuesSince` — backs throughput + lead-time. */
export interface DoneIssueRow {
  createdAt: string;
  statusChangedAt: string | null;
}

const MIN_DAYS = 1;
const MAX_DAYS = 365;

/** Parse + clamp a `days` query param to [1, 365], falling back to `fallback`. */
export function clampDays(raw: string | undefined, fallback: number): number {
  const parsed = parseInt(raw ?? String(fallback), 10);
  return Math.min(Math.max(Number.isNaN(parsed) ? fallback : parsed, MIN_DAYS), MAX_DAYS);
}

/** `now` shifted back `daysBack` calendar days, as a fresh Date (never mutates `now`). */
function shiftDays(now: Date, daysBack: number): Date {
  const d = new Date(now);
  d.setDate(d.getDate() - daysBack);
  return d;
}

/** The DB-side string cutoff (YYYY-MM-DD) for the trailing `days`-day window. */
export function cutoffDayFor(now: Date, days: number): string {
  return shiftDays(now, days - 1).toISOString().slice(0, 10);
}

/** Inclusive YYYY-MM-DD axis from `start` to `end` (one entry per calendar day). */
export function buildDateAxis(start: Date, end: Date): string[] {
  const dates: string[] = [];
  for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
    dates.push(d.toISOString().slice(0, 10));
  }
  return dates;
}

export interface BurndownBucket {
  date: string;
  remaining: number;
  opened: number;
  closed: number;
}

export interface BurndownResult {
  buckets: BurndownBucket[];
  startCount: number;
  endCount: number;
  totalClosed: number;
  totalOpened: number;
}

/**
 * Remaining-open issue count per day over the trailing window, plus opened/closed
 * deltas. A remaining count on day D depends on every issue ever created (one
 * opened long before the window but still open counts), so `rows` is the full
 * project timeline, not a windowed slice.
 */
export function computeBurndown(rows: StatusTimelineRow[], days: number, now: Date): BurndownResult {
  const cutoff = shiftDays(now, days - 1);

  // Per issue: the day it entered the board (createdAt) and the day it stopped
  // being open (statusChangedAt when the current status is terminal; an issue
  // created straight into a terminal status with no explicit move never opened).
  const items = rows.map((r) => {
    const createdDay = r.createdAt.slice(0, 10);
    let closedDay: string | null = null;
    if (isTerminalStatusName(r.statusName)) {
      closedDay = r.statusChangedAt ? r.statusChangedAt.slice(0, 10) : createdDay;
    }
    return { createdDay, closedDay };
  });

  const buckets = buildDateAxis(cutoff, now).map((date) => {
    let remaining = 0;
    let opened = 0;
    let closed = 0;
    for (const it of items) {
      if (it.createdDay <= date) {
        if (it.closedDay === null || it.closedDay > date) remaining++;
        if (it.createdDay === date) opened++;
      }
      if (it.closedDay === date) closed++;
    }
    return { date, remaining, opened, closed };
  });

  return {
    buckets,
    startCount: buckets.length > 0 ? buckets[0].remaining : 0,
    endCount: buckets.length > 0 ? buckets[buckets.length - 1].remaining : 0,
    totalClosed: buckets.reduce((s, b) => s + b.closed, 0),
    totalOpened: buckets.reduce((s, b) => s + b.opened, 0),
  };
}

export interface CfdResult {
  statuses: string[];
  counts: { date: string; status: string; count: number }[];
}

/**
 * Cumulative flow: for each day, the count of issues that had entered each status
 * by the end of that day. An issue counts in status X on day D when its current
 * status is X and it entered on/before D (statusChangedAt, or createdAt when no
 * explicit status change is recorded). The CFD axis spans the full trailing `days`
 * plus today (start = now - days), matching the original handler.
 */
export function computeCfd(rows: StatusTimelineRow[], days: number, now: Date): CfdResult {
  const cutoff = shiftDays(now, days);

  // Statuses sorted by board column order.
  const statusMeta = new Map<string, { sortOrder: number }>();
  for (const r of rows) {
    if (!statusMeta.has(r.statusName)) {
      statusMeta.set(r.statusName, { sortOrder: r.statusSortOrder });
    }
  }
  const statuses = [...statusMeta.entries()]
    .sort((a, b) => a[1].sortOrder - b[1].sortOrder)
    .map(([name]) => name);

  const counts: { date: string; status: string; count: number }[] = [];
  for (const date of buildDateAxis(cutoff, now)) {
    const byStatus = new Map<string, number>();
    for (const s of statuses) byStatus.set(s, 0);
    for (const r of rows) {
      const enteredDay = (r.statusChangedAt ?? r.createdAt).slice(0, 10);
      if (enteredDay <= date) {
        byStatus.set(r.statusName, (byStatus.get(r.statusName) ?? 0) + 1);
      }
    }
    for (const [status, count] of byStatus) {
      counts.push({ date, status, count });
    }
  }

  return { statuses, counts };
}

export interface ThroughputResult {
  points: { date: string; count: number }[];
}

/** Issues moved into Done per calendar day across the trailing window. */
export function computeThroughput(rows: DoneIssueRow[], days: number, now: Date): ThroughputResult {
  const dates = buildDateAxis(shiftDays(now, days - 1), now);
  const countByDate = new Map<string, number>(dates.map((d) => [d, 0]));
  for (const r of rows) {
    if (!r.statusChangedAt) continue;
    const movedDay = r.statusChangedAt.slice(0, 10);
    if (countByDate.has(movedDay)) {
      countByDate.set(movedDay, (countByDate.get(movedDay) ?? 0) + 1);
    }
  }
  return { points: dates.map((date) => ({ date, count: countByDate.get(date) ?? 0 })) };
}

/** Linear-interpolated percentile of an already-sorted ascending array. */
function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

export interface LeadTimeBucket {
  date: string;
  count: number;
  medianMs: number | null;
  p90Ms: number | null;
}

export interface LeadTimeResult {
  buckets: LeadTimeBucket[];
}

/**
 * Lead-time trend: median + p90 of (Done statusChangedAt − createdAt) per day for
 * issues that reached Done in the window. Days with no completions report null.
 */
export function computeLeadTime(rows: DoneIssueRow[], days: number, now: Date): LeadTimeResult {
  const dates = buildDateAxis(shiftDays(now, days - 1), now);
  const byDate = new Map<string, number[]>(dates.map((d) => [d, []]));
  for (const r of rows) {
    if (!r.statusChangedAt || !r.createdAt) continue;
    const day = r.statusChangedAt.slice(0, 10);
    if (!byDate.has(day)) continue;
    const leadMs = new Date(r.statusChangedAt).getTime() - new Date(r.createdAt).getTime();
    if (leadMs >= 0) byDate.get(day)!.push(leadMs);
  }

  const buckets = dates.map((date) => {
    const vals = [...(byDate.get(date) ?? [])].sort((a, b) => a - b);
    return {
      date,
      count: vals.length,
      medianMs: vals.length > 0 ? percentile(vals, 50) : null,
      p90Ms: vals.length > 0 ? percentile(vals, 90) : null,
    };
  });

  return { buckets };
}
