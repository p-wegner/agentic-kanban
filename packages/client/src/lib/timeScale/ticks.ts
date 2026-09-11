// Two-band tick generation for the timeScale axis (#1088/#1090): major labelled boundaries
// plus minor gridlines, snapped to calendar boundaries per scale. Split out of the former
// monolithic timeScale.ts (#889 god-module gate).

import type { Scale, TickBands, TimeWindow, Tick } from "./types";
import { HOUR_MS } from "./types";
import { addDays, addMonths, addQuarters, addWeeks, snapDown } from "./calendarMath";

function fmt(ts: number, opts: Intl.DateTimeFormatOptions): string {
  return new Date(ts).toLocaleDateString("en-US", opts);
}

/**
 * Two-band ticks for `win` at `scale`, snapped to calendar boundaries. Day/week major labels
 * omit the year by default (#1088 R2) — spelling it out on every tick would be noise on a
 * window that never leaves one year — and add it back only on the tick where the year actually
 * changes from the previous one, so a window straddling New Year's doesn't show two identically
 * labelled "Dec 31"/"Jan 1"-shaped ticks with no way to tell which year is which.
 */
export function ticksFor(win: TimeWindow, scale: Scale): TickBands {
  const major: Tick[] = [];
  const minor: Tick[] = [];

  switch (scale) {
    case "day": {
      let prevYear: number | null = null;
      for (let ts = snapDown(win.min, "day"); ts <= win.max; ts = addDays(ts, 1)) {
        const year = new Date(ts).getFullYear();
        const showYear = prevYear !== null && year !== prevYear;
        major.push({ ts, label: fmt(ts, showYear ? { month: "short", day: "numeric", year: "numeric" } : { month: "short", day: "numeric" }) });
        prevYear = year;
      }
      const dayStart = snapDown(win.min, "day");
      for (let ts = dayStart; ts <= win.max; ts += 6 * HOUR_MS) {
        if (ts >= win.min) minor.push({ ts, label: new Date(ts).toLocaleTimeString("en-US", { hour: "numeric" }) });
      }
      break;
    }
    case "week": {
      let prevYear: number | null = null;
      for (let ts = snapDown(win.min, "week"); ts <= win.max; ts = addWeeks(ts, 1)) {
        const year = new Date(ts).getFullYear();
        const showYear = prevYear !== null && year !== prevYear;
        major.push({ ts, label: `Week of ${fmt(ts, showYear ? { month: "short", day: "numeric", year: "numeric" } : { month: "short", day: "numeric" })}` });
        prevYear = year;
      }
      for (let ts = snapDown(win.min, "day"); ts <= win.max; ts = addDays(ts, 1)) {
        minor.push({ ts, label: fmt(ts, { weekday: "narrow" }) });
      }
      break;
    }
    case "month": {
      for (let ts = snapDown(win.min, "month"); ts <= win.max; ts = addMonths(ts, 1)) {
        major.push({ ts, label: fmt(ts, { month: "long", year: "numeric" }) });
      }
      for (let ts = snapDown(win.min, "week"); ts <= win.max; ts = addWeeks(ts, 1)) {
        minor.push({ ts, label: fmt(ts, { month: "short", day: "numeric" }) });
      }
      break;
    }
    case "quarter": {
      for (let ts = snapDown(win.min, "quarter"); ts <= win.max; ts = addQuarters(ts, 1)) {
        const q = Math.floor(new Date(ts).getMonth() / 3) + 1;
        major.push({ ts, label: `Q${q} ${new Date(ts).getFullYear()}` });
      }
      for (let ts = snapDown(win.min, "month"); ts <= win.max; ts = addMonths(ts, 1)) {
        minor.push({ ts, label: fmt(ts, { month: "short" }) });
      }
      break;
    }
  }
  return { major, minor };
}
