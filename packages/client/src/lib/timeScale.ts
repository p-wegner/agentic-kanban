// Pure time-scale model for TimelineView (#1088, follow-up to #1086's R1/R2/P1-6).
//
// Everything here is plain local-time `Date` math (no date library dependency in this
// package) — snapping to calendar boundaries (day/Monday/1st-of-month/quarter-start) rather
// than proportional spacing is what makes zoom and the axis mean something: #1086 measured
// the old zoom as a CSS `min-width` multiplier with no effect on what is actually shown, and
// the old axis as 4-10 evenly-spaced points with no relation to calendar boundaries.
//
// A `Viewport` is the persisted state (scale + anchor + zoom level); `windowFor` turns it
// into the visible [min,max] time range for a given track width, snapped outward to whole
// calendar units of the current scale so ticks land cleanly at both edges.

export type Scale = "day" | "week" | "month" | "quarter";

/** Coarse → fine. Index order is what `zoomAround` walks when crossing a density threshold. */
const SCALE_ORDER: readonly Scale[] = ["quarter", "month", "week", "day"];

export interface Viewport {
  scale: Scale;
  /** Left edge of the visible window before snapping, ms epoch (local time). */
  anchor: number;
  /** Zoom level: horizontal pixels per millisecond. */
  pxPerMs: number;
}

export interface TimeWindow {
  min: number;
  max: number;
}

export interface Tick {
  ts: number;
  label: string;
}

/** Two-band axis: `major` carries the labelled boundaries, `minor` the finer gridlines. */
export interface TickBands {
  major: Tick[];
  minor: Tick[];
}

export interface ClippedSpan {
  x: number;
  width: number;
  clippedStart: boolean;
  clippedEnd: boolean;
}

export const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;

/** Target zoom density (px/day) per scale, and the range before crossing to a neighbour. */
const SCALE_PX_PER_DAY: Record<Scale, { min: number; default: number; max: number }> = {
  quarter: { min: 1, default: 3, max: 6 },
  month: { min: 6, default: 10, max: 20 },
  week: { min: 20, default: 40, max: 80 },
  day: { min: 80, default: 120, max: 400 },
};

function pxPerMsFromPxPerDay(pxPerDay: number): number {
  return pxPerDay / DAY_MS;
}

export function defaultPxPerMs(scale: Scale): number {
  return pxPerMsFromPxPerDay(SCALE_PX_PER_DAY[scale].default);
}

function pxPerMsRangeFor(scale: Scale): { min: number; max: number } {
  const { min, max } = SCALE_PX_PER_DAY[scale];
  return { min: pxPerMsFromPxPerDay(min), max: pxPerMsFromPxPerDay(max) };
}

function finerScale(scale: Scale): Scale | null {
  const i = SCALE_ORDER.indexOf(scale);
  return i < SCALE_ORDER.length - 1 ? SCALE_ORDER[i + 1] : null;
}

function coarserScale(scale: Scale): Scale | null {
  const i = SCALE_ORDER.indexOf(scale);
  return i > 0 ? SCALE_ORDER[i - 1] : null;
}

// --- calendar boundary math (local time throughout, so DST shifts fall out for free) -------

function startOfDay(ts: number): number {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function addDays(ts: number, n: number): number {
  const d = new Date(ts);
  d.setDate(d.getDate() + n);
  return d.getTime();
}

/** Monday of the week containing `ts`. */
function startOfWeek(ts: number): number {
  const d = new Date(startOfDay(ts));
  const day = d.getDay(); // 0=Sun..6=Sat
  const diffToMonday = day === 0 ? -6 : 1 - day;
  d.setDate(d.getDate() + diffToMonday);
  return d.getTime();
}

function addWeeks(ts: number, n: number): number {
  return addDays(ts, n * 7);
}

function startOfMonth(ts: number): number {
  const d = new Date(ts);
  d.setDate(1);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function addMonths(ts: number, n: number): number {
  const d = new Date(ts);
  d.setDate(1); // pin the day-of-month first so a month-length overflow can't roll an extra month
  d.setHours(0, 0, 0, 0);
  d.setMonth(d.getMonth() + n);
  return d.getTime();
}

function startOfQuarter(ts: number): number {
  const d = new Date(ts);
  const qStartMonth = Math.floor(d.getMonth() / 3) * 3;
  return new Date(d.getFullYear(), qStartMonth, 1, 0, 0, 0, 0).getTime();
}

function addQuarters(ts: number, n: number): number {
  return addMonths(ts, n * 3);
}

function snapDown(ts: number, scale: Scale): number {
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

function stepBoundary(ts: number, scale: Scale, n: number): number {
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
function snapUp(ts: number, scale: Scale): number {
  const down = snapDown(ts, scale);
  return down === ts ? ts : stepBoundary(down, scale, 1);
}

function scaleForSpan(spanMs: number): Scale {
  const days = spanMs / DAY_MS;
  if (days <= 10) return "day";
  if (days <= 60) return "week";
  if (days <= 400) return "month";
  return "quarter";
}

// --- the model surface -----------------------------------------------------------------

/**
 * The visible [min,max] window for a viewport at a given track width, snapped outward to
 * whole calendar units of the current scale so both edges land on a boundary the axis draws.
 */
export function windowFor(viewport: Viewport, trackPx: number): TimeWindow {
  const rawMax = viewport.anchor + trackPx / viewport.pxPerMs;
  return { min: snapDown(viewport.anchor, viewport.scale), max: snapUp(rawMax, viewport.scale) };
}

/** A timestamp's horizontal pixel position within `win` over a track `trackPx` wide. */
export function xOf(ts: number, win: TimeWindow, trackPx: number): number {
  const span = win.max - win.min;
  if (span <= 0) return 0;
  return ((ts - win.min) / span) * trackPx;
}

/**
 * `[start,end]` clipped to `win` and converted to pixel geometry, or `null` when the span
 * doesn't overlap the window at all (so the caller can skip drawing it, rather than drawing a
 * zero-width bar at an edge).
 */
export function clipSpan(start: number, end: number, win: TimeWindow, trackPx: number): ClippedSpan | null {
  const lo = Math.min(start, end);
  const hi = Math.max(start, end);
  if (hi < win.min || lo > win.max) return null;
  const clampedStart = Math.max(lo, win.min);
  const clampedEnd = Math.min(hi, win.max);
  const x = xOf(clampedStart, win, trackPx);
  const width = Math.max(0, xOf(clampedEnd, win, trackPx) - x);
  return { x, width, clippedStart: lo < win.min, clippedEnd: hi > win.max };
}

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

/**
 * Zoom by `factor` (>1 = in, <1 = out) around `focusTs`, keeping that timestamp under the
 * same pixel offset it currently occupies. Crossing a scale's density threshold switches to
 * the neighbouring scale (day↔week↔month↔quarter) rather than drawing an unreadably dense or
 * sparse view at the wrong granularity; at the finest/coarsest scale the zoom simply clamps.
 */
export function zoomAround(viewport: Viewport, factor: number, focusTs: number, trackPx: number): Viewport {
  const focusOffsetPx = (focusTs - viewport.anchor) * viewport.pxPerMs;

  let scale = viewport.scale;
  let pxPerMs = viewport.pxPerMs * factor;

  const range = pxPerMsRangeFor(scale);
  if (pxPerMs > range.max) {
    const finer = finerScale(scale);
    if (finer) {
      scale = finer;
      pxPerMs = defaultPxPerMs(scale);
    } else {
      pxPerMs = range.max;
    }
  } else if (pxPerMs < range.min) {
    const coarser = coarserScale(scale);
    if (coarser) {
      scale = coarser;
      pxPerMs = defaultPxPerMs(scale);
    } else {
      pxPerMs = range.min;
    }
  }

  // The anchor is kept exact (not snapped) here — `windowFor` snaps it for DISPLAY on every
  // render, but snapping the stored value would round it towards a calendar boundary on every
  // zoom step, permanently losing precision and drifting the focus point over repeated zooms.
  const anchor = focusTs - focusOffsetPx / pxPerMs;
  return { scale, anchor, pxPerMs };
}

/** Move the viewport by one calendar unit of its current scale (day/week/month/quarter). */
export function stepAnchor(viewport: Viewport, direction: 1 | -1): Viewport {
  return { ...viewport, anchor: stepBoundary(snapDown(viewport.anchor, viewport.scale), viewport.scale, direction) };
}

/** A viewport centred on `now` at the given scale/zoom. */
export function viewportForToday(scale: Scale, pxPerMs: number, trackPx: number, now: number = Date.now()): Viewport {
  const span = trackPx / pxPerMs;
  return { scale, anchor: snapDown(now - span / 2, scale), pxPerMs };
}

/**
 * A viewport that fits `[dataMin, dataMax]` into `trackPx`, computed once from the data.
 *
 * The span is measured from the SNAPPED anchor to the snapped-up end, not from the raw
 * `dataMin`/`dataMax` — snapping the anchor down (to a day/week/month/quarter boundary)
 * shortens how much of the raw span is left to cover `dataMax` if the pixel density were
 * derived from the raw span alone, which could push `dataMax` (often "now") just outside the
 * resulting window.
 */
export function viewportForFitAll(dataMin: number, dataMax: number, trackPx: number, preferredScale?: Scale): Viewport {
  const rawSpan = Math.max(dataMax - dataMin, DAY_MS);
  const scale = preferredScale ?? scaleForSpan(rawSpan);
  const anchor = snapDown(dataMin, scale);
  const snappedMax = snapUp(Math.max(dataMax, anchor + DAY_MS), scale);
  const span = Math.max(snappedMax - anchor, DAY_MS);
  return { scale, anchor, pxPerMs: trackPx / span };
}

/** Re-anchor a viewport onto a new scale, keeping `focusTs` at the same relative position. */
export function withScale(viewport: Viewport, scale: Scale, focusTs: number, trackPx: number): Viewport {
  if (scale === viewport.scale) return viewport;
  const pxPerMs = defaultPxPerMs(scale);
  const span = trackPx / pxPerMs;
  const anchor = focusTs - span / 2;
  return { scale, anchor: snapDown(anchor, scale), pxPerMs };
}

/** Local-midnight parse of a `YYYY-MM-DD` date-only string (falls back to native parsing). */
export function parseLocalDate(value: string): Date {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
  if (m) return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return new Date(value);
}
