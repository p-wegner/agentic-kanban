// Two-band tick generation for the timeScale axis (#1088/#1090): major labelled boundaries
// plus minor gridlines, snapped to calendar boundaries per scale. Split out of the former
// monolithic timeScale.ts (#889 god-module gate).

import type { Scale, TickBands, TimeWindow, Tick } from "./types";
import { HOUR_MS } from "./types";
import { addDays, addMonths, addQuarters, addWeeks, snapDown } from "./calendarMath";

function fmt(ts: number, opts: Intl.DateTimeFormatOptions): string {
  return new Date(ts).toLocaleDateString("en-US", opts);
}

/** Two-band ticks for `win` at `scale`, snapped to calendar boundaries. */
export function ticksFor(win: TimeWindow, scale: Scale): TickBands {
  const major: Tick[] = [];
  const minor: Tick[] = [];

  switch (scale) {
    case "day": {
      for (let ts = snapDown(win.min, "day"); ts <= win.max; ts = addDays(ts, 1)) {
        major.push({ ts, label: fmt(ts, { month: "short", day: "numeric" }) });
      }
      const dayStart = snapDown(win.min, "day");
      for (let ts = dayStart; ts <= win.max; ts += 6 * HOUR_MS) {
        if (ts >= win.min) minor.push({ ts, label: new Date(ts).toLocaleTimeString("en-US", { hour: "numeric" }) });
      }
      break;
    }
    case "week": {
      for (let ts = snapDown(win.min, "week"); ts <= win.max; ts = addWeeks(ts, 1)) {
        major.push({ ts, label: `Week of ${fmt(ts, { month: "short", day: "numeric" })}` });
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
