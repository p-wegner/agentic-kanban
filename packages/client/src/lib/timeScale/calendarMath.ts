// Calendar-boundary math for the timeScale model (#1088/#1090) — local-time `Date` math
// throughout, so DST shifts and month-length overflows fall out for free. Split out of the
// former monolithic timeScale.ts (#889 god-module gate); consumed by geometry.ts, ticks.ts
// and viewport.ts, which all need to snap a timestamp onto a calendar boundary.

import type { Scale } from "./types";

export function startOfDay(ts: number): number {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

export function addDays(ts: number, n: number): number {
  const d = new Date(ts);
  d.setDate(d.getDate() + n);
  return d.getTime();
}

/** Monday of the week containing `ts`. */
export function startOfWeek(ts: number): number {
  const d = new Date(startOfDay(ts));
  const day = d.getDay(); // 0=Sun..6=Sat
  const diffToMonday = day === 0 ? -6 : 1 - day;
  d.setDate(d.getDate() + diffToMonday);
  return d.getTime();
}

export function addWeeks(ts: number, n: number): number {
  return addDays(ts, n * 7);
}

export function startOfMonth(ts: number): number {
  const d = new Date(ts);
  d.setDate(1);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

export function addMonths(ts: number, n: number): number {
  const d = new Date(ts);
  d.setDate(1); // pin the day-of-month first so a month-length overflow can't roll an extra month
  d.setHours(0, 0, 0, 0);
  d.setMonth(d.getMonth() + n);
  return d.getTime();
}

export function startOfQuarter(ts: number): number {
  const d = new Date(ts);
  const qStartMonth = Math.floor(d.getMonth() / 3) * 3;
  return new Date(d.getFullYear(), qStartMonth, 1, 0, 0, 0, 0).getTime();
}

export function addQuarters(ts: number, n: number): number {
  return addMonths(ts, n * 3);
}

export function snapDown(ts: number, scale: Scale): number {
  switch (scale) {
    case "day":
      return startOfDay(ts);
    case "week":
      return startOfWeek(ts);
    case "month":
      return startOfMonth(ts);
    case "quarter":
      return startOfQuarter(ts);
  }
}

export function stepBoundary(ts: number, scale: Scale, n: number): number {
  switch (scale) {
    case "day":
      return addDays(ts, n);
    case "week":
      return addWeeks(ts, n);
    case "month":
      return addMonths(ts, n);
    case "quarter":
      return addQuarters(ts, n);
  }
}

/** The next boundary at or after `ts` — `ts` itself if it already sits on one. */
export function snapUp(ts: number, scale: Scale): number {
  const down = snapDown(ts, scale);
  return down === ts ? ts : stepBoundary(down, scale, 1);
}
