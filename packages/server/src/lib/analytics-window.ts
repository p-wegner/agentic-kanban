/**
 * Shared time-window primitives for the board's day-bucketed analytics endpoints.
 *
 * WHY THIS EXISTS
 * Five+ route handlers across issues.ts, workspaces.ts, and projects.ts each
 * re-implemented the same three steps inline: parse+clamp a `days` query param,
 * compute a trailing-window cutoff (YYYY-MM-DD), and build a continuous date axis
 * from that cutoff up to today. Hoisting them into one tested primitive removes
 * the duplication and gives every inbound adapter (HTTP/CLI/MCP) the same window
 * semantics.
 *
 * `now` is always injected so the cutoff and the axis derive from a single
 * snapshot (stable across a query that crosses midnight) and so the math is
 * deterministically unit-testable. YYYY-MM-DD strings compare lexicographically
 * == chronologically, which is why day comparisons elsewhere use plain string `<=`.
 */

const MIN_DAYS = 1;
const MAX_DAYS = 365;

/** Parse + clamp a `days` query param to [1, 365], falling back to `fallback`. */
export function clampDays(raw: string | undefined, fallback: number): number {
  const parsed = parseInt(raw ?? String(fallback), 10);
  return Math.min(Math.max(Number.isNaN(parsed) ? fallback : parsed, MIN_DAYS), MAX_DAYS);
}

/** `now` shifted back `n` calendar days, as a fresh Date (never mutates `now`). */
export function subDays(now: Date, n: number): Date {
  const d = new Date(now);
  d.setDate(d.getDate() - n);
  return d;
}

/**
 * DB-side string cutoff (YYYY-MM-DD) for the trailing `days`-day window that
 * INCLUDES today — i.e. `now - (days - 1)`. A 1-day window is today only.
 */
export function cutoffDayFor(now: Date, days: number): string {
  return subDays(now, days - 1).toISOString().slice(0, 10);
}

/** Inclusive YYYY-MM-DD axis from `start` to `end` (one entry per calendar day). */
export function buildDateAxis(start: Date, end: Date): string[] {
  const dates: string[] = [];
  for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
    dates.push(d.toISOString().slice(0, 10));
  }
  return dates;
}
