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
//
// This file is a facade barrel — the implementation lives in cohesive sub-modules under
// `timeScale/` (#889 god-module gate: the original single file declared 28 top-level
// functions). Import from here; the split below is an internal organisation detail.

export type { Scale, Viewport, TimeWindow, Tick, TickBands, ClippedSpan } from "./timeScale/types";
export { DAY_MS } from "./timeScale/types";

export { defaultPxPerMs } from "./timeScale/scaleDensity";
export { windowFor, xOf, clipSpan, tsAtOffset } from "./timeScale/geometry";
export { ticksFor } from "./timeScale/ticks";
export { zoomAround, stepAnchor, panBy, viewportForToday, viewportForFitAll, withScale, parseLocalDate } from "./timeScale/viewport";
