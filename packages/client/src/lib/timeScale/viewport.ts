// Viewport operations for the timeScale model (#1088/#1090): zoom, pan, and the initial
// viewports (today-centred, fit-all-data). Split out of the former monolithic timeScale.ts
// (#889 god-module gate).

import type { Scale, Viewport } from "./types";
import { DAY_MS } from "./types";
import { snapDown, snapUp, stepBoundary } from "./calendarMath";
import { coarserScale, defaultPxPerMs, finerScale, pxPerMsRangeFor, scaleForSpan } from "./scaleDensity";

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
export function viewportForToday(scale: Scale, pxPerMs: number, trackPx: number, nowMs: number = Date.now()): Viewport {
  const span = trackPx / pxPerMs;
  return { scale, anchor: snapDown(nowMs - span / 2, scale), pxPerMs };
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
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (m) return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return new Date(value);
}
