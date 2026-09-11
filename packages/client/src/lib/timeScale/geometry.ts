// Pixel geometry for the timeScale model (#1088/#1090): the visible window for a viewport,
// and converting timestamps/spans to pixel positions within it. Split out of the former
// monolithic timeScale.ts (#889 god-module gate).

import type { ClippedSpan, TimeWindow, Viewport } from "./types";
import { snapDown, snapUp } from "./calendarMath";

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
 * Inverse of `xOf`: the timestamp under a pixel offset within `win` over a track `trackPx`
 * wide (#1099 R1) — lets an interaction (wheel-zoom, click) target the timestamp under the
 * cursor instead of always the window's midpoint. `offsetPx` is clamped to `[0, trackPx]` so a
 * cursor briefly outside the track (e.g. mid-drag) still resolves to an in-window timestamp.
 */
export function tsAtOffset(win: TimeWindow, offsetPx: number, trackPx: number): number {
  if (trackPx <= 0) return win.min;
  const clamped = Math.min(Math.max(offsetPx, 0), trackPx);
  return win.min + (clamped / trackPx) * (win.max - win.min);
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
